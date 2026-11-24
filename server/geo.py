"""Transformacje układów i wyprowadzenie poligonu wycinka z geometrii OSM."""
from collections import defaultdict, deque

import numpy as np
import shapely
from pyproj import Transformer
from pyproj.transformer import TransformerGroup
from shapely.geometry import LineString, Point
from shapely.ops import linemerge, substring, unary_union

WGS84, PL1992 = "EPSG:4326", "EPSG:2180"
_forward = Transformer.from_crs(WGS84, PL1992, always_xy=True)
_inverse = Transformer.from_crs(PL1992, WGS84, always_xy=True)

ROAD_CLASSES = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
                "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"}
PATH_CLASSES = {"cycleway", "path", "footway", "steps", "pedestrian"}


def transform_info():
    operation = TransformerGroup(WGS84, PL1992, always_xy=True).transformers[0]
    return {"from": WGS84, "to": PL1992, "operation": operation.description, "accuracyMeters": operation.accuracy}


def to_pl1992(lon, lat):
    return _forward.transform(lon, lat)


def to_wgs84(east, north):
    return _inverse.transform(east, north)


def project_store(store):
    ids = np.fromiter(store["node"].keys(), dtype=np.int64)
    lon = np.fromiter((n["lon"] for n in store["node"].values()), dtype=float)
    lat = np.fromiter((n["lat"] for n in store["node"].values()), dtype=float)
    east, north = _forward.transform(lon, lat)
    for i, node_id in enumerate(ids.tolist()):
        node = store["node"][node_id]
        node["e"], node["n"] = float(east[i]), float(north[i])


def way_line(store, way):
    points = [(store["node"][r]["e"], store["node"][r]["n"]) for r in way["nodes"] if r in store["node"]]
    return LineString(points) if len(points) >= 2 else None


def _is_separated(tags):
    highway = tags.get("highway", "")
    return ("bridge" in tags and tags["bridge"] != "no") or ("tunnel" in tags and tags["tunnel"] != "no") \
        or tags.get("layer", "0") != "0" or highway.endswith("_link")


def derive_polygon(store, scene):
    """Poligon = węzeł (spójna sieć bezkolizyjna od mostu) + dojazdy + rzeka ±zasięg, z buforem.

    Most, relacja trasy i odcinki rzeki są wskazane w konfiguracji sceny (config/sources.json), a nie w kodzie.

    „Uproszczenie sieci” jest tu zdefiniowane jawnie: przeszukiwanie idzie po drogach i ścieżkach
    z mostem, tunelem, niezerową warstwą lub typem *_link, a kończy się na pierwszym zwykłym odcinku
    w poziomie terenu, który dołącza się jako dojazd.
    """
    ways = store["way"]
    bridge = way_line(store, ways[scene["seedBridgeWay"]])
    bridge_area = shapely.Polygon(bridge.coords) if bridge.is_ring else bridge
    wanted = ROAD_CLASSES | PATH_CLASSES
    network = {i: w for i, w in ways.items() if w["tags"].get("highway") in wanted and len(w["nodes"]) >= 2}
    by_node = defaultdict(list)
    for way_id, way in network.items():
        for ref in way["nodes"]:
            by_node[ref].append(way_id)

    route_members = {m["ref"] for m in store["relation"][scene["seedRouteRelation"]]["members"] if m["type"] == "way"}
    prepared = shapely.prepared.prep(bridge_area.buffer(5))
    seeds = [i for i, w in network.items() if _is_separated(w["tags"]) and (line := way_line(store, w))
             and prepared.intersects(line)]
    limit = bridge_area.centroid.buffer(scene.get("networkRadiusMeters", 3500))
    interchange, approaches, queue = set(seeds), set(), deque(seeds)
    while queue:
        for ref in network[queue.popleft()]["nodes"]:
            for other in by_node[ref]:
                if other in interchange or other in approaches:
                    continue
                line = way_line(store, network[other])
                if line is None or not limit.intersects(line):
                    continue
                if _is_separated(network[other]["tags"]):
                    interchange.add(other)
                    queue.append(other)
                else:
                    approaches.add(other)

    river_ids = set(scene["riverWays"])
    river = linemerge([way_line(store, ways[i]) for i in river_ids if i in ways and way_line(store, ways[i])])
    if river.geom_type != "LineString":
        river = max(river.geoms, key=lambda g: g.intersection(bridge_area.buffer(50)).length)
    crossing = river.project(bridge_area.centroid)
    reach = substring(river, max(0, crossing - scene["riverReachMeters"]),
                      min(river.length, crossing + scene["riverReachMeters"]))
    water = [shapely.Polygon(way_line(store, w).coords) for w in ways.values()
             if w["tags"].get("natural") == "water" and w["nodes"][0] == w["nodes"][-1]
             and len(w["nodes"]) >= 4 and way_line(store, w).intersects(reach)]

    parts = [way_line(store, network[i]) for i in interchange | approaches]
    corridor = unary_union([g.buffer(scene["bufferMeters"]) for g in parts + [bridge_area, reach] + water])
    if corridor.geom_type == "MultiPolygon":
        corridor = shapely.convex_hull(corridor)
    polygon = shapely.Polygon(corridor.exterior).simplify(10)
    return polygon, {
        "interchangeWays": len(interchange), "approachWays": len(approaches), "seedWays": sorted(seeds),
        "routeMembersInCorridor": sum(1 for i in route_members if i in interchange | approaches),
        "riverReachMeters": round(reach.length), "riverCrossing": [round(v, 1) for v in
                                                                  river.interpolate(crossing).coords[0]],
        "areaKm2": round(polygon.area / 1e6, 3), "boundsPl1992": [round(v, 1) for v in polygon.bounds],
    }


def contains(polygon, x, y):
    return shapely.contains_xy(polygon, x, y)


__all__ = ["Point", "derive_polygon", "project_store", "to_pl1992", "to_wgs84", "transform_info", "contains"]
