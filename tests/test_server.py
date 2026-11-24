"""Testy serwera: python -m unittest discover -s tests"""
import json
import tempfile
import unittest
from pathlib import Path

import jsonschema
import numpy as np
from pyproj import Transformer

from server.adapters.nmt import parse_ascii_grid, select_sheets
from server.adapters.osm import cells, new_store, parse_osm
from server.app import PROFILE, SCHEMA, load_profile
from server.cache import Cache
from server.config import load_sources
from server.geo import to_pl1992, to_wgs84
from server.terrain import INTERPOLATED, MISSING, OK, Terrain
from server.tiles import TileGrid, merge_tiles
from shapely.geometry import box


class CacheTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cache = Cache(Path(self.temp.name), 30)

    def tearDown(self):
        self.cache.db.close()
        self.temp.cleanup()

    def test_default_limit_from_config_is_10_gb(self):
        self.assertEqual(load_sources()["cache"]["defaultLimitBytes"], 10_000_000_000)

    def test_lru_removes_least_recently_used(self):
        for key in "abc":
            self.cache.put(key, b"x" * 10, "t")
        self.cache.get("a")
        self.cache.put("d", b"x" * 10, "t")
        self.assertIsNotNone(self.cache.path("a"))
        self.assertIsNone(self.cache.path("b"))

    def test_active_scene_is_never_evicted(self):
        self.cache.put("active", b"x" * 20, "t")
        self.cache.protect(["active"])
        self.cache.put("other", b"x" * 20, "t")
        self.assertIsNotNone(self.cache.path("active"))
        self.cache.set_limit(5)
        self.assertIsNotNone(self.cache.path("active"))
        self.assertTrue(self.cache.stats()["overLimitBecauseProtected"])

    def test_survives_reopen(self):
        self.cache.put("k", b"abc", "t", {"url": "u"})
        self.cache.db.close()
        self.cache = Cache(Path(self.temp.name), 30)
        self.assertEqual(self.cache.get("k"), b"abc")
        self.assertEqual(self.cache.meta("k")["url"], "u")


class CrsTest(unittest.TestCase):
    def test_round_trip_is_submillimetre(self):
        east, north = to_pl1992(21.0975, 52.2138)
        lon, lat = to_wgs84(east, north)
        self.assertAlmostEqual(lon, 21.0975, 8)
        self.assertAlmostEqual(lat, 52.2138, 8)

    def test_matches_independent_tmerc_definition(self):
        reference = Transformer.from_crs(
            "+proj=longlat +ellps=GRS80",
            "+proj=tmerc +lat_0=0 +lon_0=19 +k=0.9993 +x_0=500000 +y_0=-5300000 +ellps=GRS80", always_xy=True)
        expected = reference.transform(21.0975, 52.2138)
        actual = to_pl1992(21.0975, 52.2138)
        self.assertAlmostEqual(actual[0], expected[0], 2)
        self.assertAlmostEqual(actual[1], expected[1], 2)


class OsmParserTest(unittest.TestCase):
    def test_keeps_all_tags_roles_and_metadata(self):
        xml = b"""<osm><node id="1" lat="52" lon="21" version="3" timestamp="t"><tag k="x:unknown" v="?"/></node>
        <way id="2" version="1"><nd ref="1"/><tag k="foo" v="bar"/></way>
        <relation id="3"><member type="way" ref="2" role="outer"/><tag k="type" v="multipolygon"/></relation></osm>"""
        store = new_store()
        parse_osm(xml, store)
        self.assertEqual(store["node"][1]["tags"], {"x:unknown": "?"})
        self.assertEqual(store["node"][1]["meta"]["version"], "3")
        self.assertEqual(store["relation"][3]["members"][0]["role"], "outer")

    def test_cells_cover_bbox(self):
        parts = list(cells({"west": 0, "south": 0, "east": 0.1, "north": 0.04}, {"lon": 0.025, "lat": 0.02}))
        self.assertEqual(len(parts), 8)
        self.assertEqual(parts[-1][2:], (0.1, 0.04))


class NmtTest(unittest.TestCase):
    def test_parser_orders_rows_from_south_and_marks_nodata(self):
        data = b"ncols 2\r\nnrows 2\r\nxllcenter 10.00\r\nyllcenter 20.00\r\ncellsize 1.00\r\nnodata_value -9999\r\n1 2\r\n3 -9999\r\n"
        grid, west, south = parse_ascii_grid(data)
        self.assertEqual((west, south), (10, 20))
        self.assertEqual(grid[0, 0], 3)
        self.assertTrue(np.isnan(grid[0, 1]))
        self.assertEqual(grid[1, 1], 2)

    def test_rejects_sheets_in_other_vertical_datum(self):
        cfg = {"requiredVerticalDatum": "PL-EVRF2007-NH", "requiredHorizontalCrs": "PL-1992",
               "requiredFormat": "ARC/INFO ASCII GRID", "requiredResolution": "1.00 m"}
        base = {"horizontalCrs": "PL-1992", "format": "ARC/INFO ASCII GRID", "resolution": "1.00 m",
                "footprint": box(0, 0, 100, 100), "date": "2025-01-01", "sheet": "A"}
        chosen, uncovered = select_sheets([{**base, "verticalDatum": "PL-KRON86-NH"}], cfg, (0, 0, 100, 100))
        self.assertEqual(chosen, [])
        self.assertEqual(uncovered, 10000)


class TerrainTest(unittest.TestCase):
    def build(self):
        grid = np.arange(400, dtype=np.float32).reshape(20, 20)
        grid[5, 5] = np.nan
        grid[10:18, 10:18] = np.nan
        return Terrain.mosaic((0, 0, 19, 19), [(grid, 0, 0)])[0]

    def test_small_gap_is_interpolated_and_flagged_large_gap_stays_missing(self):
        terrain = self.build()
        self.assertEqual(terrain.flags[5, 5], INTERPOLATED)
        self.assertEqual(terrain.flags[14, 14], MISSING)
        self.assertTrue(np.isnan(terrain.height[14, 14]))
        self.assertEqual(terrain.flags[0, 0], OK)

    def test_bilinear_sample(self):
        self.assertAlmostEqual(float(self.build().sample(np.array([1.5]), np.array([0.0]))[0]), 1.5, 5)

    def test_tile_size_and_empty_tile(self):
        terrain = self.build()
        terrain.build_levels()
        # Korzeń 2^20 m od (0, 0): kafel 128 m na poziomie 13 o indeksie (0, 0) zaczyna się w (0, 0).
        tile = terrain.tile(13, 0, 0, (0, 0))
        self.assertEqual(len(tile), 129 * 129 * 5)
        self.assertIsNone(terrain.tile(13, 100, 100, (0, 0)))


class TerrainLodTest(unittest.TestCase):
    def test_coarse_tile_keeps_true_position_of_surface(self):
        rows, columns = np.mgrid[0:600, 0:600]
        plane = (80 + 0.05 * columns + 0.02 * rows).astype(np.float32)
        terrain = Terrain.mosaic((0, 0, 599, 599), [(plane, 0, 0)])[0]
        terrain.build_levels()
        size = 129
        for z, cell, index in ((12, 2, 0), (11, 4, 0)):
            data = np.frombuffer(terrain.tile(z, index, index, (0, 0))[:size * size * 4], dtype=np.float32).reshape(size, size)
            step = 1048576 / 2 ** z / 128
            self.assertEqual(step, cell)
            expected = 80 + 0.05 * np.arange(size) * step
            np.testing.assert_allclose(data[10, 5:60], expected[5:60] + 0.02 * 10 * step, atol=0.002)


class ProfileTest(unittest.TestCase):
    def test_profile_is_valid_and_references_are_closed(self):
        profile = load_profile()
        classes = set(profile["classes"])
        self.assertLessEqual({r["setClass"] for r in profile["rules"] if "setClass" in r}, classes)
        self.assertLessEqual({c["group"] for c in profile["classes"].values()}, set(profile["groups"]))

    def test_schema_rejects_executable_or_unknown_fields(self):
        profile = json.loads(PROFILE.read_text(encoding="utf-8"))
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
        profile["rules"][0]["script"] = "alert(1)"
        with self.assertRaises(jsonschema.ValidationError):
            jsonschema.validate(profile, schema, cls=jsonschema.Draft202012Validator)


if __name__ == "__main__":
    unittest.main()


class DataTileTest(unittest.TestCase):
    def test_grid_is_global_and_bbox_round_trips(self):
        grid = TileGrid({"lon": 0.025, "lat": 0.02})
        i, j = grid.of(21.0912, 52.2143)
        west, south, east, north = grid.bbox(i, j)
        self.assertTrue(west <= 21.0912 < east and south <= 52.2143 < north)
        self.assertAlmostEqual(east - west, 0.025, 6)
        # Kafel sąsiedni zaczyna się dokładnie tam, gdzie kończy się poprzedni.
        self.assertEqual(grid.bbox(i + 1, j)[0], east)

    def test_polygon_in_pl1992_covers_cell(self):
        grid = TileGrid({"lon": 0.025, "lat": 0.02})
        polygon = grid.polygon(*grid.of(21.09, 52.21))
        self.assertTrue(1500 < polygon.bounds[2] - polygon.bounds[0] < 1800)
        self.assertTrue(2100 < polygon.bounds[3] - polygon.bounds[1] < 2300)

    def test_multipolygon_keeps_all_outers_in_every_tile(self):
        """Kafel przecinający jeden wielokąt relacji dostaje całą relację (klient trzyma jeden obiekt na identyfikator)."""
        from server.pipeline import SceneBuilder

        class FlatTerrain:
            def source_at(self, east, north):
                return None

            def sample(self, xs, ys):
                return np.zeros(len(xs))

        store = new_store()
        squares = {10: (0, 0), 20: (5000, 0)}
        for way_id, (x, y) in squares.items():
            refs = []
            for k, (dx, dy) in enumerate([(0, 0), (100, 0), (100, 100), (0, 100)]):
                store["node"][way_id + k] = {"lon": 0, "lat": 0, "tags": {}, "meta": {}, "e": x + dx, "n": y + dy}
                refs.append(way_id + k)
            store["way"][way_id] = {"nodes": refs + [refs[0]], "tags": {}, "meta": {}}
        store["relation"][7] = {"members": [{"type": "way", "ref": 10, "role": "outer"}, {"type": "way", "ref": 20, "role": "outer"}],
                                "tags": {"type": "multipolygon", "landuse": "forest"}, "meta": {}}
        core, detail, _, _ = SceneBuilder(None, None, None, None)._features(store, box(-50, -50, 50, 50), FlatTerrain(), (0, 0), [])
        forest = [f for f in core + detail if f["id"] == "r7"]
        self.assertEqual(len(forest), 1)
        self.assertEqual(len(forest[0]["polygons"]), 2)
        none, more, _, _ = SceneBuilder(None, None, None, None)._features(store, box(2000, 2000, 2100, 2100), FlatTerrain(), (0, 0), [])
        self.assertFalse([f for f in none + more if f["id"] == "r7"])

    def test_merge_prefers_first_source_and_fills_gaps(self):
        a = np.array([1, np.nan, 3], dtype=np.float32).tobytes() + bytes([0, 2, 0])
        b = np.array([9, 2, 9], dtype=np.float32).tobytes() + bytes([1, 0, 1])
        merged = merge_tiles([a, None, b])
        np.testing.assert_array_equal(np.frombuffer(merged[:12], dtype=np.float32), [1, 2, 3])
        self.assertEqual(list(merged[12:]), [0, 0, 0])
        self.assertIsNone(merge_tiles([None]))
