// Podpory estakad. Podpory z OSM mają pierwszeństwo; pozostałe są osobno oznaczonym wnioskiem z geometrii.
// Obiekty wywnioskowane nie dostają tagów i nie stają się danymi OSM. man_made=pier pozostaje pomostem.
import { pointInRing } from "./diagnostics.js";

const OBSTACLE_CELL = 24;
// Klucz liczbowy komórki siatki przeszkód (całkowite indeksy do ±2^20).
const cellKey = (i, j) => (i + 1048576) * 2097152 + (j + 1048576);

export const isElevatedWay = (state) => {
  const { level, interp, feature } = state;
  if (!level || feature.geometry !== "way" || interp.geometry !== "line" || interp.classDef.levelCheck !== "transport" || interp.classDef.stairs) return false;
  return level.lifted ? level.units > 0 : level.maxOffset > 0.4;
};

const widthOf = (state) => state.interp.dimensions.width?.value ?? state.interp.classDef.widthMeters ?? 2;

function ringsOf(feature) {
  if (feature.geometry === "multipolygon") return feature.polygons;
  const ring = [];
  for (let i = 0; i < feature.points.length; i += 3) ring.push(feature.points[i], feature.points[i + 1]);
  return [[ring]];
}

function bounds(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]); maxX = Math.max(maxX, ring[i]);
    minY = Math.min(minY, ring[i + 1]); maxY = Math.max(maxY, ring[i + 1]);
  }
  return { minX, minY, maxX, maxY };
}

function buildObstacles(model) {
  const segments = new Map(), areas = [];
  const add = (x, y, item) => {
    const key = cellKey(Math.floor(x / OBSTACLE_CELL), Math.floor(y / OBSTACLE_CELL));
    if (!segments.has(key)) segments.set(key, []);
    segments.get(key).push(item);
  };
  for (const state of model.states.values()) {
    const { interp, feature, level } = state, def = interp.classDef;
    if (feature.geometry === "way" && interp.geometry === "line" && level && (def.levelCheck === "transport" || def.levelCheck === "water")) {
      const { points } = feature, half = widthOf(state) / 2;
      for (let i = 1; i < level.z.length; i += 1) {
        const item = { state, half, ax: points[i * 3 - 3], ay: points[i * 3 - 2], bx: points[i * 3], by: points[i * 3 + 1], az: level.z[i - 1], bz: level.z[i], water: def.levelCheck === "water" };
        const steps = Math.ceil(Math.hypot(item.bx - item.ax, item.by - item.ay) / OBSTACLE_CELL) + 1;
        const seen = new Set();
        for (let k = 0; k <= steps; k += 1) {
          const x = item.ax + ((item.bx - item.ax) * k) / steps, y = item.ay + ((item.by - item.ay) * k) / steps;
          const key = cellKey(Math.floor(x / OBSTACLE_CELL), Math.floor(y / OBSTACLE_CELL));
          if (!seen.has(key)) { seen.add(key); add(x, y, item); }
        }
      }
    } else if (interp.geometry === "area" && (def.render === "extrude" || interp.classId === "water.area")) {
      for (const rings of ringsOf(feature)) areas.push({ state, rings, kind: def.render === "extrude" ? "building" : "water", ...bounds(rings[0]) });
    }
  }
  return { segments, areas };
}

/** Pierwsza przeszkoda w miejscu słupa pod pomostem: woda, budynek albo trasa przechodząca niżej. */
function blockedBy(obstacles, x, y, underside, radius, own, margin) {
  for (const area of obstacles.areas) {
    if (x < area.minX - radius || x > area.maxX + radius || y < area.minY - radius || y > area.maxY + radius) continue;
    if (pointInRing(x, y, area.rings[0]) && !area.rings.slice(1).some((hole) => pointInRing(x, y, hole))) return area.kind;
  }
  const cx = Math.floor(x / OBSTACLE_CELL), cy = Math.floor(y / OBSTACLE_CELL);
  for (let i = cx - 1; i <= cx + 1; i += 1) for (let j = cy - 1; j <= cy + 1; j += 1) {
    for (const s of obstacles.segments.get(cellKey(i, j)) ?? []) {
      if (s.state === own) continue;
      const dx = s.bx - s.ax, dy = s.by - s.ay;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / (dx * dx + dy * dy || 1)));
      if (Math.hypot(x - s.ax - t * dx, y - s.ay - t * dy) > s.half + radius + margin) continue;
      if (s.az + (s.bz - s.az) * t < underside - 0.3) return s.water ? "water" : "route";
    }
  }
  return null;
}

function stationsOf(state, model) {
  const points = model.surfaces?.byId.get(state.feature.id)?.axis ?? state.feature.points, { z } = state.level, along = [0];
  for (let i = 1; i < z.length; i += 1) along.push(along[i - 1] + Math.hypot(points[i * 3] - points[i * 3 - 3], points[i * 3 + 1] - points[i * 3 - 2]));
  const at = (s) => {
    let i = 1;
    while (i < along.length - 1 && along[i] < s) i += 1;
    const span = along[i] - along[i - 1] || 1, t = Math.max(0, Math.min(1, (s - along[i - 1]) / span));
    const a = (i - 1) * 3, b = i * 3, ga = points[a + 2], gb = points[b + 2];
    const tx = points[b] - points[a], ty = points[b + 1] - points[a + 1], l = Math.hypot(tx, ty) || 1;
    return {
      x: points[a] + tx * t, y: points[a + 1] + ty * t, z: z[i - 1] + (z[i] - z[i - 1]) * t,
      ground: ga === null || gb === null ? null : ga + (gb - ga) * t, tx: tx / l, ty: ty / l,
    };
  };
  return { length: along[along.length - 1], at };
}

export function inferSupports(model) {
  const cfg = model.profile.inferredSupports;
  const items = [], issues = [];
  const stats = { osm: 0, inferred: 0, shared: 0, stationsChecked: 0, lowClearance: 0, blocked: { water: 0, route: 0, building: 0 }, elevatedWays: 0, waysWithoutSupport: 0 };
  const obstacles = buildObstacles(model);
  const elevated = [...model.states.values()].filter(isElevatedWay);
  const nearSupport = (x, y, top, distance) => items.some((s) => Math.hypot(s.x - x, s.y - y) < distance && Math.abs(s.top - top) < 2.5);
  const radiusOf = (state) => (cfg.columnWidthMeters / 2) * (widthOf(state) >= 5 ? 1 : 0.55);

  for (const state of model.states.values()) {
    if (state.interp.classId !== "structure.support") continue;
    const { feature } = state;
    const ring = feature.geometry === "point" ? null : ringsOf(feature)[0][0];
    const x = feature.point?.[0] ?? ring.reduce((t, v, i) => (i % 2 ? t : t + v), 0) / (ring.length / 2);
    const y = feature.point?.[1] ?? ring.reduce((t, v, i) => (i % 2 ? t + v : t), 0) / (ring.length / 2);
    let best = null;
    for (const deck of elevated) {
      const { points } = deck.feature;
      for (let i = 0; i < deck.level.z.length; i += 1) {
        const d = Math.hypot(points[i * 3] - x, points[i * 3 + 1] - y);
        if (d < 20 && (!best || d < best.distance)) best = { deck, i, distance: d };
      }
    }
    const ground = feature.point?.[2] ?? feature.anchor?.[2] ?? feature.points?.[2] ?? null;
    if (!best || ground === null) {
      issues.push({ key: `support-no-deck:${feature.id}`, code: "support-no-deck", category: "uncertain", status: "informacja", severity: 1, confidence: "średnia", message: "Podpora z OSM nie ma w pobliżu pomostu, do którego można ją przypisać.", reason: "Szukano podniesionej trasy do 20 m od podpory.", objects: [feature.id], location: [x, y, ground ?? 0], suggest: [] });
      continue;
    }
    items.push({ id: feature.id, source: "osm", x, y, top: best.deck.level.z[best.i] - cfg.deckThicknessMeters, bottom: ground, radius: cfg.columnWidthMeters / 2, tx: 1, ty: 0, deckWidth: widthOf(best.deck), deckId: best.deck.feature.id });
    stats.osm += 1;
  }

  for (const state of elevated) {
    stats.elevatedWays += 1;
    const { length, at } = stationsOf(state, model), radius = radiusOf(state), own = items.length;
    const count = Math.max(1, Math.floor(length / cfg.spacingMeters));
    let blockedStations = 0, reason = null;
    for (let k = 0; k < count; k += 1) {
      const target = ((k + 0.5) * length) / count;
      stats.stationsChecked += 1;
      let placed = false, anyClearance = false, firstBlock = null;
      for (let step = 0; step <= cfg.spacingMeters * 0.4 && !placed; step += 3) {
        for (const sign of step ? [1, -1] : [1]) {
          const s = target + sign * step;
          if (s < 4 || s > length - 4) continue;
          const p = at(s);
          if (p.ground === null) continue;
          const underside = p.z - cfg.deckThicknessMeters;
          if (underside - p.ground < cfg.minClearanceMeters) continue;
          anyClearance = true;
          if (nearSupport(p.x, p.y, underside, cfg.mergeDistanceMeters)) { stats.shared += 1; placed = true; break; }
          const block = blockedBy(obstacles, p.x, p.y, underside, radius, state, cfg.obstacleMarginMeters);
          if (block) { firstBlock ??= block; continue; }
          items.push({ id: `inferred:support:${state.feature.id}:${k}`, source: "inferred", x: p.x, y: p.y, top: underside, bottom: p.ground, radius, tx: p.tx, ty: p.ty, deckWidth: widthOf(state), deckId: state.feature.id });
          stats.inferred += 1;
          placed = true;
          break;
        }
      }
      if (placed) continue;
      if (!anyClearance) stats.lowClearance += 1;
      else { stats.blocked[firstBlock] += 1; blockedStations += 1; reason ??= firstBlock; }
    }
    if (items.length === own && blockedStations && !items.some((s) => s.deckId === state.feature.id)) {
      stats.waysWithoutSupport += 1;
      const p = at(length / 2);
      const label = { water: "wodą", route: "trasą poniżej", building: "budynkiem" }[reason];
      issues.push({ key: `support-unplaced:${state.feature.id}`, code: "support-unplaced", category: "uncertain", status: "informacja", severity: 1, confidence: "niska", message: `Nie wywnioskowano podpory: wolne miejsce pod pomostem koliduje z ${label}.`, reason: "OSM nie zawiera bridge:support dla tego przebiegu, a generator nie stawia słupa w kolizji.", objects: [state.feature.id], location: [p.x, p.y, p.z], suggest: [{ key: "bridge:support", reason: "Zmapowana podpora zastąpi wniosek z geometrii.", doc: "https://wiki.openstreetmap.org/wiki/Key:bridge:support" }] });
    }
  }
  return { items, byId: new Map(items.map((s) => [s.id, s])), stats, issues };
}
