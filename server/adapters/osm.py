"""Adapter OSM API 0.6: pobiera obszar komórkami i scala bez utraty tagów, ról ani metadanych."""
import math
import urllib.error
import xml.etree.ElementTree as ET


def _meta(element):
    return {k: element.get(k) for k in ("version", "timestamp", "changeset") if element.get(k)}


def _tags(element):
    return {t.get("k"): t.get("v") for t in element.findall("tag")}


def new_store():
    return {"node": {}, "way": {}, "relation": {}}


def parse_osm(xml_bytes, store):
    root = ET.fromstring(xml_bytes)
    for n in root.findall("node"):
        if n.get("visible", "true") != "false":
            store["node"][int(n.get("id"))] = {"lon": float(n.get("lon")), "lat": float(n.get("lat")),
                                               "tags": _tags(n), "meta": _meta(n)}
    for w in root.findall("way"):
        if w.get("visible", "true") != "false":
            store["way"][int(w.get("id"))] = {"nodes": [int(nd.get("ref")) for nd in w.findall("nd")],
                                              "tags": _tags(w), "meta": _meta(w)}
    for r in root.findall("relation"):
        if r.get("visible", "true") != "false":
            store["relation"][int(r.get("id"))] = {
                "members": [{"type": m.get("type"), "ref": int(m.get("ref")), "role": m.get("role", "")}
                            for m in r.findall("member")],
                "tags": _tags(r), "meta": _meta(r)}


def cells(bbox, step):
    """Dzieli obwiednię na komórki, aby nie przekroczyć limitu węzłów OSM API."""
    columns = math.ceil(round((bbox["east"] - bbox["west"]) / step["lon"], 9))
    rows = math.ceil(round((bbox["north"] - bbox["south"]) / step["lat"], 9))
    for i in range(columns):
        for j in range(rows):
            yield (round(bbox["west"] + i * step["lon"], 6), round(bbox["south"] + j * step["lat"], 6),
                   round(min(bbox["east"], bbox["west"] + (i + 1) * step["lon"]), 6),
                   round(min(bbox["north"], bbox["south"] + (j + 1) * step["lat"]), 6))


class OsmAdapter:
    def __init__(self, cfg, scene_cfg, cache, fetcher):
        self.cfg, self.scene, self.cache, self.fetcher = cfg, scene_cfg, cache, fetcher

    def _cached(self, key, url, keys):
        keys.append(key)
        data = self.cache.get(key)
        if data is None:
            data = self.fetcher.get(url)
            self.cache.put(key, data, self.cfg["id"], {"url": url})
        return data

    def _fetch_cell(self, snapshot, cell, store, keys, progress):
        """Pobiera komórkę; gdy OSM API zgłosi przekroczenie limitu węzłów, dzieli ją na cztery."""
        box = ",".join(f"{v:.6f}" for v in cell)
        split_key = f"osm/{snapshot}/split/{box}"
        must_split = self.cache.get(split_key) is not None
        if not must_split:
            try:
                progress(f"OSM: obszar {box}")
                parse_osm(self._cached(f"osm/{snapshot}/map/{box}", f"{self.cfg['apiBase']}/map?bbox={box}", keys), store)
                return
            except urllib.error.HTTPError as error:
                keys.pop()
                if error.code != 400 or b"too many nodes" not in error.read():
                    raise
                self.cache.put(split_key, b"1", self.cfg["id"])
        keys.append(split_key)
        west, south, east, north = cell
        mid_lon, mid_lat = round((west + east) / 2, 6), round((south + north) / 2, 6)
        for part in ((west, south, mid_lon, mid_lat), (mid_lon, south, east, mid_lat),
                     (west, mid_lat, mid_lon, north), (mid_lon, mid_lat, east, north)):
            self._fetch_cell(snapshot, part, store, keys, progress)

    def fetch_area(self, snapshot, progress=lambda message: None):
        store, keys = new_store(), []
        for cell in cells(self.scene["searchBboxWgs84"], self.cfg["cellDegrees"]):
            self._fetch_cell(snapshot, cell, store, keys, progress)
        return store, keys

    def fetch_relation_full(self, snapshot, relation_id, store, keys):
        url = f"{self.cfg['apiBase']}/relation/{relation_id}/full"
        parse_osm(self._cached(f"osm/{snapshot}/relation/{relation_id}", url, keys), store)
