"""Kafle danych: komórki OSM w globalnej siatce stopni, budowane w tle, trwałe w cache i wersjonowane.

Kafel to komórka 0,025° × 0,02° (konfiguracja osm.cellDegrees). Budowa kafla: OSM dla komórki, uzupełnienie
wielokątów przecinających kafel, NMT z arkuszy dla zasięgu kafla z marginesem, obiekty w formacie migawki sceny.
Odświeżenie kafla pobiera OSM ponownie i zapisuje nową wersję; poprzednia wersja jest używana do czasu jej gotowości.
"""
import gzip
import json
import math
import threading
import time
import traceback
from collections import deque
from datetime import datetime, timezone

import numpy as np
from shapely.geometry import Polygon

from . import geo
from .adapters.nmt import NmtAdapter
from .adapters.osm import OsmAdapter, new_store
from .pipeline import SceneBuilder
from .terrain import Terrain

TERRAIN_MARGIN = 300  # m poza kaflem: drogi przecinające granicę mają wysokość także za nią
MAX_TERRAINS = 16     # mozaiki terenu trzymane w pamięci; dalsze są odczytywane z cache przy potrzebie
STALE_SECONDS = 20    # kafel, o który klient przestał pytać (kamera odjechała), wypada z kolejki
# Wersja formatu obiektów kafla: kafel zbudowany starszym formatem jest budowany ponownie (z OSM z cache, bez pobierania).
# 2: multipolygon zawsze z wszystkimi wielokątami relacji.
FEATURES_FORMAT = 2


class TileGrid:
    def __init__(self, cell):
        self.dlon, self.dlat = cell["lon"], cell["lat"]

    def of(self, lon, lat):
        return math.floor(lon / self.dlon), math.floor(lat / self.dlat)

    def bbox(self, i, j):
        return (round(i * self.dlon, 6), round(j * self.dlat, 6), round((i + 1) * self.dlon, 6), round((j + 1) * self.dlat, 6))

    def polygon(self, i, j, steps=8):
        """Obrys kafla w EPSG:2180 (krawędzie zagęszczone, bo południki i równoleżniki nie są prostymi w PL-1992)."""
        west, south, east, north = self.bbox(i, j)
        ring = []
        for k in range(steps):
            ring.append(geo.to_pl1992(west + (east - west) * k / steps, south))
        for k in range(steps):
            ring.append(geo.to_pl1992(east, south + (north - south) * k / steps))
        for k in range(steps):
            ring.append(geo.to_pl1992(east - (east - west) * k / steps, north))
        for k in range(steps):
            ring.append(geo.to_pl1992(west, north - (north - south) * k / steps))
        return Polygon(ring)


class TileStore:
    """Budowa kafli w jednym wątku (OSM API ma limit zapytań), stan i dane dla klienta."""

    def __init__(self, config, cache, fetcher, origin_fn):
        self.cfg, self.cache, self.fetcher, self.origin_fn = config, cache, fetcher, origin_fn
        self.grid = TileGrid(config["osm"]["cellDegrees"])
        self.lock = threading.Lock()
        self.queue = deque()
        self.status = {}      # (i, j) -> {"state", "message", "error", "version"}
        self.terrains = {}    # (i, j) -> Terrain z piramidą, ostatnio używane na końcu
        self.wanted = {}      # (i, j) -> czas ostatniego zapytania klienta
        self.wake = threading.Event()
        threading.Thread(target=self._worker, daemon=True).start()

    # --- stan i kolejka -------------------------------------------------------------------------
    def _meta(self, key):
        raw = self.cache.get_setting(f"tile:{key[0]}:{key[1]}")
        return json.loads(raw) if raw else None

    def info(self, key):
        with self.lock:
            current = dict(self.status.get(key, {}))
        meta = self._meta(key)
        ready = bool(meta and meta.get("format") == FEATURES_FORMAT and self.cache.path(f"tile/{key[0]}/{key[1]}/{meta['version']}/features"))
        state = current.get("state") or ("ready" if ready else "missing")
        return {"i": key[0], "j": key[1], "state": state, "ready": ready, "message": current.get("message", ""),
                "error": current.get("error"), "version": meta["version"] if meta else None,
                "fetchedAt": meta["fetchedAt"] if meta else None, "bbox": self.grid.bbox(*key)}

    def request(self, key, refresh=False):
        """Dopisuje kafel do kolejki, gdy nie jest gotowy (albo przy odświeżeniu); zwraca stan."""
        info = self.info(key)
        with self.lock:
            self.wanted[key] = time.time()
            queued = any(k == key for k, _ in self.queue) or self.status.get(key, {}).get("state") == "building"
            if not queued and (refresh or not info["ready"]):
                self.queue.append((key, refresh))
                self.status[key] = {"state": "queued", "message": "W kolejce", "error": None}
                self.wake.set()
        return self.info(key)

    def _worker(self):
        while True:
            self.wake.wait()
            with self.lock:
                if not self.queue:
                    self.wake.clear()
                    continue
                key, refresh = self.queue.popleft()
                if not refresh and time.time() - self.wanted.get(key, 0) > STALE_SECONDS:
                    self.status.pop(key, None)
                    continue
                self.status[key] = {"state": "building", "message": "Start", "error": None}
            try:
                self.build(key, refresh)
                with self.lock:
                    self.status.pop(key, None)
            except Exception as error:  # noqa: BLE001 - błąd kafla trafia do klienta, pozostałe kafle działają dalej
                traceback.print_exc()
                with self.lock:
                    self.status[key] = {"state": "error", "message": "", "error": str(error)}

    def _progress(self, key):
        def report(message):
            print(f"Kafel {key}: {message}", flush=True)
            with self.lock:
                if key in self.status:
                    self.status[key]["message"] = message
        return report

    # --- budowa ---------------------------------------------------------------------------------
    def build(self, key, refresh=False):
        i, j = key
        progress = self._progress(key)
        previous = self._meta(key)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        # Odświeżenie: nowa przestrzeń kluczy OSM, więc dane są pobierane ponownie; bez odświeżenia używany jest cache kafla.
        namespace = f"tile/{i}/{j}/{stamp if refresh or not previous else previous.get('osmNamespace', stamp)}"
        version = stamp
        keys = []
        scene_cfg = self.cfg["scene"]
        osm = OsmAdapter(self.cfg["osm"], scene_cfg, self.cache, self.fetcher)
        store = new_store()
        osm._fetch_cell(namespace, self.grid.bbox(i, j), store, keys, progress)
        progress("Transformacja WGS84 → EPSG:2180")
        geo.project_store(store)
        polygon = self.grid.polygon(i, j)
        builder = SceneBuilder(self.cfg, self.cache, self.fetcher, progress)
        progress("Relacje wielokątów przecinające kafel")
        builder._complete_multipolygons(osm, namespace, store, polygon, keys)
        geo.project_store(store)
        minx, miny, maxx, maxy = polygon.bounds
        extent = (math.floor(minx) - TERRAIN_MARGIN, math.floor(miny) - TERRAIN_MARGIN,
                  math.ceil(maxx) + TERRAIN_MARGIN, math.ceil(maxy) + TERRAIN_MARGIN)
        nmt = NmtAdapter(self.cfg["nmt"], self.cache, self.fetcher)
        progress("NMT: skorowidz arkuszy")
        sheets, uncovered = nmt.find_sheets(namespace, extent, keys)
        grids = []
        for index, sheet in enumerate(sheets):
            progress(f"NMT: arkusz {index + 1}/{len(sheets)} ({sheet['sheet']})")
            grids.append(nmt.load(sheet, keys))
        progress("NMT: mozaika")
        terrain, seams = Terrain.mosaic(extent, grids)
        del grids
        progress("Obiekty kafla")
        core, detail, relations, counts = builder._features(store, polygon, terrain, self.origin_fn(), sheets)
        fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        origin = self.origin_fn()
        meta = {"version": version, "format": FEATURES_FORMAT, "osmNamespace": namespace.rsplit("/", 1)[-1], "fetchedAt": fetched_at, "counts": counts,
                "seams": seams, "uncoveredM2": round(uncovered, 1),
                "extent": [extent[0] - origin[0], extent[1] - origin[1], extent[2] - origin[0], extent[3] - origin[1]],
                "sheets": [{k: s[k] for k in ("sheet", "date", "verticalErrorMeters", "horizontalErrorMeters", "method", "url")} for s in sheets]}
        body = {"tile": {"i": i, "j": j, **meta}, "features": core + detail, "relations": relations}
        prefix = f"tile/{i}/{j}/{version}"
        self.cache.put(f"{prefix}/features", gzip.compress(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 5), "tile")
        self.cache.put(f"{prefix}/terrain", terrain.to_bytes(), "tile")
        keys += [f"{prefix}/features", f"{prefix}/terrain"]
        self.cache.add_protected(keys)
        self.cache.set_setting(f"tile:{i}:{j}", json.dumps(meta))
        terrain.build_levels()
        with self.lock:
            self.terrains.pop(key, None)
            self.terrains[key] = terrain
        progress("Gotowe")

    # --- odczyt -----------------------------------------------------------------------------------
    def features(self, key):
        meta = self._meta(key)
        return self.cache.get(f"tile/{key[0]}/{key[1]}/{meta['version']}/features") if meta else None

    def terrain(self, key):
        """Mozaika terenu kafla (z piramidą); wczytywana z cache przy pierwszym użyciu."""
        with self.lock:
            if key in self.terrains:
                terrain = self.terrains.pop(key)
                self.terrains[key] = terrain
                return terrain
        meta = self._meta(key)
        path = meta and self.cache.path(f"tile/{key[0]}/{key[1]}/{meta['version']}/terrain")
        if not path:
            return None
        terrain = Terrain.from_file(path)
        terrain.build_levels()
        with self.lock:
            self.terrains[key] = terrain
            while len(self.terrains) > MAX_TERRAINS:
                self.terrains.pop(next(iter(self.terrains)))
        return terrain

    def ready_terrains(self, keys):
        return [t for t in (self.terrain(k) for k in keys if self.info(k)["ready"]) if t is not None]

    def keys_near(self, east, north, radius=1):
        lon, lat = geo.to_wgs84(east, north)
        ci, cj = self.grid.of(lon, lat)
        # Kafel pod kamerą jest budowany pierwszy, potem sąsiednie (najpierw boczne, na końcu narożne).
        keys = [(ci + di, cj + dj) for dj in range(-radius, radius + 1) for di in range(-radius, radius + 1)]
        return sorted(keys, key=lambda k: (abs(k[0] - ci) + abs(k[1] - cj), k))

    def keys_in(self, west, south, east, north):
        """Kafle przecinające prostokąt w EPSG:2180 (do odczytu terenu)."""
        corners = [geo.to_wgs84(x, y) for x, y in ((west, south), (east, south), (east, north), (west, north))]
        i0, j0 = self.grid.of(min(c[0] for c in corners), min(c[1] for c in corners))
        i1, j1 = self.grid.of(max(c[0] for c in corners), max(c[1] for c in corners))
        if (i1 - i0 + 1) * (j1 - j0 + 1) > 400:
            return []
        return [(i, j) for i in range(i0, i1 + 1) for j in range(j0, j1 + 1)]


def merge_tiles(parts):
    """Łączy kafle wysokości z kilku mozaik: pierwsza mozaika z danymi w punkcie ma pierwszeństwo."""
    size = None
    heights, flags = None, None
    for data in parts:
        if data is None:
            continue
        cells = len(data) // 5
        h = np.frombuffer(data[:cells * 4], dtype=np.float32).copy()
        f = np.frombuffer(data[cells * 4:], dtype=np.uint8).copy()
        if heights is None:
            heights, flags, size = h, f, cells
            continue
        take = ~np.isfinite(heights) & np.isfinite(h)
        heights[take] = h[take]
        flags[take] = f[take]
    if heights is None or not np.isfinite(heights).any():
        return None
    return heights.astype(np.float32).tobytes() + flags.astype(np.uint8).tobytes()
