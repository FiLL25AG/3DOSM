"""Budowa migawki sceny: OSM → EPSG:2180 → poligon → NMT → obiekty z zachowanymi tagami."""
import gzip
import json
import math
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np
import shapely
from shapely.geometry import LineString, Polygon, box
from shapely.ops import linemerge, polygonize, unary_union

from . import geo
from .adapters.nmt import NmtAdapter
from .adapters.osm import OsmAdapter, new_store
from .terrain import MAX_LEVEL, ROOT_SIZE, ROOT_SOUTH, ROOT_WEST, TILE_CELLS, Terrain

DENSIFY_METERS = 15.0
TERRAIN_MARGIN = 100
AREA_ONLY_KEYS = ("building", "building:part", "landuse", "natural", "leisure", "amenity", "area")
CORE_HIGHWAYS = {"motorway", "trunk", "primary", "secondary", "tertiary", "motorway_link", "trunk_link",
                 "primary_link", "secondary_link", "tertiary_link"}


def _round(values, digits=2):
    return [None if v is None or not math.isfinite(v) else round(float(v), digits) for v in values]


def _densify(xy, step=DENSIFY_METERS):
    """Zagęszcza linię; zwraca punkty i indeks każdego oryginalnego węzła w wyniku."""
    points, node_index = [xy[0]], [0]
    for (x0, y0), (x1, y1) in zip(xy, xy[1:]):
        count = max(1, int(math.hypot(x1 - x0, y1 - y0) / step))
        for k in range(1, count + 1):
            t = k / count
            points.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
        node_index.append(len(points) - 1)
    return points, node_index


def _is_core(tags):
    return tags.get("highway") in CORE_HIGHWAYS or "railway" in tags or tags.get("waterway") == "river" \
        or tags.get("natural") == "water" or tags.get("man_made") == "bridge" \
        or (tags.get("highway") in geo.PATH_CLASSES and tags.get("bridge", "no") != "no")


def _assemble_multipolygon(store, relation):
    """Składa geometrię z ról outer/inner bez modyfikowania członków."""
    lines = {"outer": [], "inner": []}
    missing = 0
    for member in relation["members"]:
        if member["type"] != "way" or member["role"] not in ("outer", "inner", ""):
            continue
        way = store["way"].get(member["ref"])
        line = geo.way_line(store, way) if way else None
        if line is None or any(ref not in store["node"] for ref in way["nodes"]):
            missing += 1
            continue
        lines["inner" if member["role"] == "inner" else "outer"].append(line)
    outers = list(polygonize(linemerge(lines["outer"]))) if lines["outer"] else []
    inners = list(polygonize(linemerge(lines["inner"]))) if lines["inner"] else []
    return outers, inners, missing


class SceneBuilder:
    def __init__(self, config, cache, fetcher, progress):
        self.cfg, self.cache, self.fetcher, self.progress = config, cache, fetcher, progress

    def build(self, snapshot):
        scene_cfg = self.cfg["scene"]
        keys = []
        osm = OsmAdapter(self.cfg["osm"], scene_cfg, self.cache, self.fetcher)
        store, osm_keys = osm.fetch_area(snapshot, self.progress)
        keys += osm_keys
        self.progress("Transformacja WGS84 → EPSG:2180")
        geo.project_store(store)
        polygon, polygon_info = geo.derive_polygon(store, scene_cfg)
        self.progress("Relacje wielokątów przecinające poligon")
        self._complete_multipolygons(osm, snapshot, store, polygon, keys)
        geo.project_store(store)

        minx, miny, maxx, maxy = polygon.bounds
        extent = (math.floor(minx) - TERRAIN_MARGIN, math.floor(miny) - TERRAIN_MARGIN,
                  math.ceil(maxx) + TERRAIN_MARGIN, math.ceil(maxy) + TERRAIN_MARGIN)
        origin = (round((extent[0] + extent[2]) / 2), round((extent[1] + extent[3]) / 2))
        nmt = NmtAdapter(self.cfg["nmt"], self.cache, self.fetcher)
        self.progress("NMT: skorowidz arkuszy")
        sheets, uncovered = nmt.find_sheets(snapshot, extent, keys)
        grids = []
        for index, sheet in enumerate(sheets):
            self.progress(f"NMT: arkusz {index + 1}/{len(sheets)} ({sheet['sheet']})")
            grids.append(nmt.load(sheet, keys))
        self.progress("NMT: mozaika i kontrola zakładek")
        terrain, seams = Terrain.mosaic(extent, grids)
        del grids
        coverage = terrain.coverage(lambda x, y: shapely.contains_xy(polygon, x, y))

        self.progress("Obiekty sceny")
        core, detail, relations, counts = self._features(store, polygon, terrain, origin, sheets)
        fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        west, south = geo.to_wgs84(origin[0], origin[1])
        north_e, north_n = geo.to_pl1992(west, south + 0.01)
        manifest = {
            "snapshot": snapshot, "name": scene_cfg["name"], "fetchedAt": fetched_at,
            "origin": {"east": origin[0], "north": origin[1], "lon": west, "lat": south,
                       "gridConvergenceDegrees": round(math.degrees(math.atan2(north_e - origin[0], north_n - origin[1])), 4)},
            "crs": {"source": geo.WGS84, "local": geo.PL1992, "vertical": self.cfg["nmt"]["requiredVerticalDatum"],
                    "transform": geo.transform_info()},
            "polygon": _round([v for p in polygon.exterior.coords for v in (p[0] - origin[0], p[1] - origin[1])]),
            "polygonInfo": polygon_info,
            "terrainExtent": [extent[0] - origin[0], extent[1] - origin[1], extent[2] - origin[0], extent[3] - origin[1]],
            "tiles": {"rootSize": ROOT_SIZE, "cells": TILE_CELLS, "maxLevel": MAX_LEVEL, "rootWest": ROOT_WEST - origin[0], "rootSouth": ROOT_SOUTH - origin[1]},
            "terrain": {"coverageInPolygon": coverage, "uncoveredExtentM2": round(uncovered, 1), "seams": seams,
                        "fillRule": "luki do 3 m interpolowane i oznaczone; większe pozostają brakiem danych"},
            "counts": counts,
            "sources": [
                {**{k: self.cfg["osm"][k] for k in ("id", "label", "crs", "license")}, "role": "geometria i tagi",
                 "fetchedAt": fetched_at},
                {**{k: self.cfg["nmt"][k] for k in ("id", "label", "license")}, "role": "powierzchnia gruntu",
                 "crs": self.cfg["nmt"]["requiredHorizontalCrs"], "verticalDatum": self.cfg["nmt"]["requiredVerticalDatum"],
                 "resolution": self.cfg["nmt"]["requiredResolution"],
                 "sheets": [{k: s[k] for k in ("sheet", "date", "verticalErrorMeters", "horizontalErrorMeters",
                                               "method", "url")} for s in sheets]},
            ],
            "missingLayers": [
                {"id": "nmpt-lidar", "label": "NMPT / LiDAR", "reason": "nie włączono do tego wycinka; poziomy pomostów pozostają przybliżone"},
                {"id": "bdot10k", "label": "BDOT10k (hydrografia)", "reason": "adapter niewdrożony; pokrycie i warunki produktu do sprawdzenia"},
                {"id": "mphp10k", "label": "MPHP10k", "reason": "WFS wymaga logowania ISOK; dostęp wektorowy niepotwierdzony"},
                {"id": "orto", "label": "Ortofotomapa", "reason": "warstwa opcjonalna; źródło i warunki usługi niezweryfikowane"},
            ],
        }
        blobs = {"manifest": json.dumps(manifest, ensure_ascii=False).encode("utf-8"),
                 "core": self._pack(core, relations), "detail": self._pack(detail, {})}
        for name, data in blobs.items():
            key = f"scene/{snapshot}/{name}"
            self.cache.put(key, data, "scene")
            keys.append(key)
        key = f"scene/{snapshot}/terrain"
        self.cache.put(key, terrain.to_bytes(), "scene")
        keys.append(key)
        self.cache.set_setting(f"keys:{snapshot}", json.dumps(sorted(set(keys))))
        return snapshot

    @staticmethod
    def _pack(features, relations):
        return gzip.compress(json.dumps({"features": features, "relations": relations}, ensure_ascii=False,
                                        separators=(",", ":")).encode("utf-8"), 5)

    def _complete_multipolygons(self, osm, snapshot, store, polygon, keys):
        prepared = shapely.prepared.prep(polygon)
        for relation_id, relation in list(store["relation"].items()):
            if relation["tags"].get("type") != "multipolygon":
                continue
            refs = [m["ref"] for m in relation["members"] if m["type"] == "way"]
            present = [store["way"][r] for r in refs if r in store["way"]]
            touches = any((line := self._safe_line(store, w)) is not None and prepared.intersects(line) for w in present)
            complete = len(present) == len(refs) and all(n in store["node"] for w in present for n in w["nodes"])
            if touches and not complete:
                extra = new_store()
                osm.fetch_relation_full(snapshot, relation_id, extra, keys)
                for kind in ("node", "way", "relation"):
                    for item_id, item in extra[kind].items():
                        store[kind].setdefault(item_id, item)

    @staticmethod
    def _safe_line(store, way):
        points = [(store["node"][r]["e"], store["node"][r]["n"]) for r in way["nodes"]
                  if r in store["node"] and "e" in store["node"][r]]
        return LineString(points) if len(points) >= 2 else None

    def _features(self, store, polygon, terrain, origin, sheets):
        ox, oy = origin
        prepared = shapely.prepared.prep(polygon)
        memberships = defaultdict(list)
        for relation_id, relation in store["relation"].items():
            for member in relation["members"]:
                memberships[(member["type"], member["ref"])].append(
                    {"id": relation_id, "role": member["role"], "type": relation["tags"].get("type"),
                     "name": relation["tags"].get("name:pl") or relation["tags"].get("name"),
                     "route": relation["tags"].get("route")})
        core, detail = [], []
        used_relations = set()

        def common(kind, osm_id, element, east, north):
            source_index = terrain.source_at(east, north)
            relations = memberships.get((kind, osm_id), [])
            used_relations.update(r["id"] for r in relations)
            return {"id": f"{kind[0]}{osm_id}", "osmType": kind, "osmId": osm_id, "tags": element["tags"],
                    "meta": element["meta"], "relations": relations,
                    "groundSheet": sheets[source_index]["sheet"] if source_index is not None else None}

        def emit(feature):
            (core if _is_core(feature["tags"]) else detail).append(feature)

        for node_id, node in store["node"].items():
            if not node["tags"] or "e" not in node or not shapely.contains_xy(polygon, node["e"], node["n"]):
                continue
            feature = common("node", node_id, node, node["e"], node["n"])
            ground = float(terrain.sample(np.array([node["e"]]), np.array([node["n"]]))[0])
            feature.update(geometry="point", point=_round([node["e"] - ox, node["n"] - oy, ground]),
                           lonLat=[node["lon"], node["lat"]])
            emit(feature)

        for way_id, way in store["way"].items():
            if not way["tags"] or any(r not in store["node"] or "e" not in store["node"][r] for r in way["nodes"]):
                continue
            xy = [(store["node"][r]["e"], store["node"][r]["n"]) for r in way["nodes"]]
            if len(xy) < 2 or not prepared.intersects(LineString(xy)):
                continue
            closed = way["nodes"][0] == way["nodes"][-1] and len(way["nodes"]) >= 4
            area_like = closed and any(k in way["tags"] for k in AREA_ONLY_KEYS)
            points, node_index = (xy, list(range(len(xy)))) if area_like else _densify(xy)
            array = np.array(points)
            ground = terrain.sample(array[:, 0], array[:, 1])
            middle = xy[len(xy) // 2]
            feature = common("way", way_id, way, middle[0], middle[1])
            feature.update(geometry="way", closed=closed,
                           points=_round([v for (x, y), z in zip(points, ground) for v in (x - ox, y - oy, z)]),
                           nodeRefs=way["nodes"], nodeIndex=node_index)
            emit(feature)

        multipolygons = 0
        for relation_id, relation in store["relation"].items():
            if relation["tags"].get("type") != "multipolygon":
                continue
            try:
                outers, inners, missing = _assemble_multipolygon(store, relation)
            except (KeyError, ValueError, shapely.errors.GEOSException):
                outers, inners, missing = [], [], len(relation["members"])
            # Relacja trafia do kafla, gdy któryś jej wielokąt go przecina, ale zawsze w całości: klient trzyma jeden
            # obiekt na identyfikator, więc kafle muszą podawać tę samą geometrię (inaczej części lasu znikały).
            if not any(prepared.intersects(p) for p in outers):
                continue
            polygons = []
            for outer in outers:
                holes = [i for i in inners if outer.contains(i.representative_point())]
                polygons.append([_round([v for x, y in ring.coords for v in (x - ox, y - oy)])
                                 for ring in [outer.exterior] + [h.exterior for h in holes]])
            point = outers[0].representative_point()
            feature = common("relation", relation_id, relation, point.x, point.y)
            ground = float(terrain.sample(np.array([point.x]), np.array([point.y]))[0])
            feature.update(geometry="multipolygon", polygons=polygons, anchor=_round([point.x - ox, point.y - oy, ground]),
                           members=relation["members"], incompleteMembers=missing)
            emit(feature)
            multipolygons += 1

        relations = {str(i): {"id": i, "tags": store["relation"][i]["tags"], "meta": store["relation"][i]["meta"],
                              "members": store["relation"][i]["members"]}
                     for i in used_relations if i in store["relation"]}
        counts = {"coreFeatures": len(core), "detailFeatures": len(detail), "multipolygons": multipolygons,
                  "relations": len(relations), "osmNodesRead": len(store["node"]), "osmWaysRead": len(store["way"])}
        return core, detail, relations, counts


__all__ = ["SceneBuilder", "Polygon", "box", "unary_union"]
