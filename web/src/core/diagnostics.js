// Diagnostyka: geometria 2D jest liczona raz, ocena tagów i poziomów po każdej zmianie.

const GRID = 60;
// Liczba tras sprawdzanych w jednym etapie szukania przecięć przy doczytywaniu kafli.
const INDEX_BATCH = 6000;
// Klucz liczbowy komórki siatki (całkowite indeksy do ±2^20): szybszy niż tekstowy, te same komórki w tej samej kolejności.
const cellKey = (i, j) => (i + 1048576) * 2097152 + (j + 1048576);

export function nodePolyline(feature) {
  const line = [];
  for (const index of feature.nodeIndex) line.push(feature.points[index * 3], feature.points[index * 3 + 1]);
  return line;
}

function segmentHit(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denominator;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denominator;
  // Styk na samym końcu odcinka nie jest przecięciem; takie przypadki są połączeniem lub dotknięciem.
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
  return [ax + t * rx, ay + t * ry];
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const length = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToRing(x, y, ring) {
  let best = Infinity;
  for (let i = 2; i < ring.length; i += 2) {
    best = Math.min(best, distanceToSegment(x, y, ring[i - 2], ring[i - 1], ring[i], ring[i + 1]));
  }
  return best;
}

function closedRing(feature) {
  const ring = [];
  for (let i = 0; i < feature.points.length; i += 3) ring.push(feature.points[i], feature.points[i + 1]);
  return ring;
}

class SegmentGrid {
  constructor() { this.cells = new Map(); }
  add(owner, ax, ay, bx, by) {
    const segment = { owner, ax, ay, bx, by, visit: 0 };
    for (let x = Math.floor(Math.min(ax, bx) / GRID); x <= Math.floor(Math.max(ax, bx) / GRID); x += 1) {
      for (let y = Math.floor(Math.min(ay, by) / GRID); y <= Math.floor(Math.max(ay, by) / GRID); y += 1) {
        const key = cellKey(x, y);
        let list = this.cells.get(key);
        if (!list) { list = []; this.cells.set(key, list); }
        list.push(segment);
      }
    }
  }
  near(x, y, radius, visit) {
    for (let i = Math.floor((x - radius) / GRID); i <= Math.floor((x + radius) / GRID); i += 1) {
      for (let j = Math.floor((y - radius) / GRID); j <= Math.floor((y + radius) / GRID); j += 1) {
        const list = this.cells.get(cellKey(i, j));
        if (list) for (const segment of list) visit(segment);
      }
    }
  }
}

/** Relacje 2D zależą tylko od geometrii, więc edycja tagów ich nie unieważnia. */
/** Przechodzi wszystkie etapy generatora naraz i zwraca wynik (wersja synchroniczna funkcji etapowej). */
export function finishSteps(steps) {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export function buildSpatialIndex(features) { return finishSteps(buildSpatialIndexSteps(features)); }

/** Indeks przestrzenny etapami: yield po każdej sekcji pozwala oddać klatkę przy doczytywaniu kafli. */
export function* buildSpatialIndexSteps(features) {
  // Czas sekcji (ms) do kontroli wydajności przy wielu kaflach danych.
  const timings = {};
  let clock = performance.now();
  const ways = features.filter((f) => f.geometry === "way" && f.points.length >= 6);
  const openOrLine = ways.filter((f) => !f.closed || f.tags.highway || f.tags.railway || f.tags.waterway);
  const closed = ways.filter((f) => f.closed);
  const grid = new SegmentGrid();
  for (const feature of ways) {
    const line = nodePolyline(feature);
    for (let i = 2; i < line.length; i += 2) grid.add(feature, line[i - 2], line[i - 1], line[i], line[i + 1]);
  }

  timings.grid = Math.round(performance.now() - clock); clock = performance.now();
  yield "indeks: grid"; clock = performance.now();
  const crossings = new Map();
  // Odcinek siatki odwiedzony już dla bieżącego odcinka a ma ten sam znacznik (zamiast osobnego zbioru na każdy odcinek).
  let visit = 0, done = 0;
  for (const a of openOrLine) {
    if ((done += 1) % INDEX_BATCH === 0) yield "indeks: crossings";
    const refs = new Set(a.nodeRefs);
    const line = nodePolyline(a);
    for (let i = 2; i < line.length; i += 2) {
      const [ax, ay, bx, by] = [line[i - 2], line[i - 1], line[i], line[i + 1]];
      const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / GRID) + 1;
      visit += 1;
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
      let previous = null;
      for (let s = 0; s <= steps; s += 1) {
        const px = ax + ((bx - ax) * s) / steps, py = ay + ((by - ay) * s) / steps;
        // Kolejne próbki w tej samej komórce nie wnoszą nowych odcinków (wszystkie są już odwiedzone).
        const key = cellKey(Math.floor(px / GRID), Math.floor(py / GRID));
        if (key === previous) continue;
        previous = key;
        for (const segment of grid.cells.get(key) ?? []) {
          if (segment.visit === visit || segment.owner === a) continue;
          segment.visit = visit;
          const b = segment.owner;
          if (b.closed && !(b.tags.highway || b.tags.railway || b.tags.waterway) ? false : a.id > b.id) continue;
          // Odcinki o rozłącznych prostokątach nie mogą się przecinać.
          if (Math.max(segment.ax, segment.bx) < x0 || Math.min(segment.ax, segment.bx) > x1 || Math.max(segment.ay, segment.by) < y0 || Math.min(segment.ay, segment.by) > y1) continue;
          const hit = segmentHit(ax, ay, bx, by, segment.ax, segment.ay, segment.bx, segment.by);
          if (!hit) continue;
          const id = `${a.id}|${b.id}|${hit[0].toFixed(1)}|${hit[1].toFixed(1)}`;
          if (!crossings.has(id)) crossings.set(id, { a: a.id, b: b.id, x: hit[0], y: hit[1], sharedNode: b.nodeRefs.some((ref) => refs.has(ref)) });
        }
      }
    }
  }

  timings.crossings = Math.round(performance.now() - clock); clock = performance.now();
  yield "indeks: crossings"; clock = performance.now();
  const proximity = [];
  for (const point of features) {
    if (point.geometry !== "point") continue;
    const [x, y] = point.point;
    const best = new Map();
    grid.near(x, y, 30, (segment) => {
      if (segment.owner.closed && !segment.owner.tags.highway) return;
      const distance = distanceToSegment(x, y, segment.ax, segment.ay, segment.bx, segment.by);
      if (distance <= 30 && distance < (best.get(segment.owner.id) ?? Infinity)) best.set(segment.owner.id, distance);
    });
    for (const [line, distance] of best) proximity.push({ point: point.id, line, distance });
  }

  timings.proximity = Math.round(performance.now() - clock); clock = performance.now();
  yield "indeks: proximity"; clock = performance.now();
  // Obrysy używane przez diagnostykę i renderer: budynki (nakładanie), konstrukcje man_made i powierzchnie dróg (trasa w obrysie).
  // Duże obszary zieleni czy zabudowy nie są tu potrzebne, a w gęstym mieście zawierają tysiące wierzchołków budynków.
  const relevant = (f) => f.tags.building !== undefined || f.tags["building:part"] !== undefined || f.tags.man_made !== undefined || f.tags["area:highway"] !== undefined;
  const rings = closed.filter(relevant).map((feature) => {
    const ring = closedRing(feature);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      minX = Math.min(minX, ring[i]); maxX = Math.max(maxX, ring[i]);
      minY = Math.min(minY, ring[i + 1]); maxY = Math.max(maxY, ring[i + 1]);
    }
    return { feature, ring, minX, minY, maxX, maxY };
  });

  timings.rings = Math.round(performance.now() - clock); clock = performance.now();
  yield "indeks: rings"; clock = performance.now();
  const contained = [];
  const overlaps = [];
  // Komórka 50 m: w gęstej zabudowie w komórce leży niewiele obrysów (przy 200 m było ich setki).
  const cell = 50;
  const ringCells = new Map();
  rings.forEach((entry) => {
    for (let x = Math.floor(entry.minX / cell); x <= Math.floor(entry.maxX / cell); x += 1) {
      for (let y = Math.floor(entry.minY / cell); y <= Math.floor(entry.maxY / cell); y += 1) {
        const key = `${x}:${y}`;
        if (!ringCells.has(key)) ringCells.set(key, []);
        ringCells.get(key).push(entry);
      }
    }
  });
  const ringsAt = (x, y) => ringCells.get(`${Math.floor(x / cell)}:${Math.floor(y / cell)}`) ?? [];
  for (const line of openOrLine) {
    const middle = line.nodeIndex[Math.floor(line.nodeIndex.length / 2)] * 3;
    const x = line.points[middle], y = line.points[middle + 1];
    for (const entry of ringsAt(x, y)) {
      if (entry.feature !== line && pointInRing(x, y, entry.ring)) contained.push({ line: line.id, area: entry.feature.id, x, y });
    }
  }
  timings.contained = Math.round(performance.now() - clock); clock = performance.now();
  yield "indeks: contained"; clock = performance.now();
  const seenPairs = new Set();
  // Nakładanie liczone tylko między budynkami (diagnostyka building-overlap).
  const isBuilding = (entry) => entry.feature.tags.building !== undefined;
  for (const entry of rings) {
    if (!isBuilding(entry)) continue;
    for (let i = 0; i < entry.ring.length - 2; i += 2) {
      const x = entry.ring[i], y = entry.ring[i + 1];
      for (const other of ringsAt(x, y)) {
        // Najpierw tani test prostokąta obrysu; klucz pary i lista węzłów tylko dla kandydatów.
        if (other === entry || !isBuilding(other) || x < other.minX || x > other.maxX || y < other.minY || y > other.maxY) continue;
        const key = `${entry.feature.id}|${other.feature.id}`;
        if (seenPairs.has(key) || other.feature.nodeRefs.includes(entry.feature.nodeRefs[i / 2])) continue;
        if (pointInRing(x, y, other.ring) && distanceToRing(x, y, other.ring) > 0.3) {
          seenPairs.add(key);
          overlaps.push({ inner: entry.feature.id, outer: other.feature.id, x, y });
        }
      }
    }
  }

  // Koniec trasy tuż przy innej trasie bez wspólnego węzła: geometria zostaje, a przypadek trafia do raportu.
  timings.overlaps = Math.round(performance.now() - clock); clock = performance.now();
  yield "indeks: overlaps"; clock = performance.now();
  const nodeUse = new Map();
  for (const way of openOrLine) for (const ref of new Set(way.nodeRefs)) nodeUse.set(ref, (nodeUse.get(ref) ?? 0) + 1);
  const endGaps = [];
  for (const way of openOrLine) {
    if (way.closed) continue;
    for (const position of [0, way.nodeRefs.length - 1]) {
      if (nodeUse.get(way.nodeRefs[position]) !== 1) continue;
      const k = way.nodeIndex[position] * 3, x = way.points[k], y = way.points[k + 1];
      const best = new Map();
      grid.near(x, y, 3, (segment) => {
        if (segment.owner === way || segment.owner.closed) return;
        const distance = distanceToSegment(x, y, segment.ax, segment.ay, segment.bx, segment.by);
        if (distance <= 3 && distance < (best.get(segment.owner.id) ?? Infinity)) best.set(segment.owner.id, distance);
      });
      for (const [other, distance] of best) endGaps.push({ way: way.id, other, distance, x, y, z: way.points[k + 2] });
    }
  }

  // Dwa różne węzły w tym samym miejscu wyglądają jak połączenie, ale w danych nim nie są.
  timings.endGaps = Math.round(performance.now() - clock); clock = performance.now();
  yield "indeks: endGaps"; clock = performance.now();
  const coincidentNodes = [];
  const owners = new Map();
  for (const way of openOrLine) {
    way.nodeRefs.forEach((ref, i) => {
      const k = way.nodeIndex[i] * 3;
      if (!owners.has(ref)) owners.set(ref, { ref, x: way.points[k], y: way.points[k + 1], z: way.points[k + 2], ways: new Set() });
      owners.get(ref).ways.add(way.id);
    });
  }
  const buckets = new Map();
  for (const node of owners.values()) {
    const key = cellKey(Math.floor(node.x), Math.floor(node.y));
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(node);
  }
  for (const node of owners.values()) {
    for (let i = Math.floor(node.x) - 1; i <= Math.floor(node.x) + 1; i += 1) {
      for (let j = Math.floor(node.y) - 1; j <= Math.floor(node.y) + 1; j += 1) {
        for (const other of buckets.get(cellKey(i, j)) ?? []) {
          if (other.ref <= node.ref || Math.hypot(other.x - node.x, other.y - node.y) >= 0.5) continue;
          for (const a of node.ways) for (const b of other.ways) if (a !== b && !other.ways.has(a) && !node.ways.has(b)) coincidentNodes.push({ way: a, other: b, distance: Math.hypot(other.x - node.x, other.y - node.y), x: node.x, y: node.y, z: node.z });
        }
      }
    }
  }
  timings.coincident = Math.round(performance.now() - clock);
  return { crossings: [...crossings.values()], proximity, contained, overlaps, endGaps, coincidentNodes, timings };
}

function order(interp) {
  const { layer, structure } = interp.attributes;
  if (layer !== undefined) return { value: layer, explicit: true };
  if (structure === "bridge" || structure === "tunnel") return { value: null, explicit: false };
  return { value: 0, explicit: false };
}

const passesUnder = (interp) => ["tunnel", "culvert", "passage"].includes(interp.attributes.structure) || interp.attributes.covered;

function describeLevel(state) {
  const { interp, level } = state;
  const { layer, structure } = interp.attributes;
  return {
    id: state.feature.id,
    layer: layer ?? null,
    structure: structure ?? null,
    z: level ? midZ(level.z) : state.feature.point?.[2] ?? state.feature.anchor?.[2] ?? null,
    method: level?.method ?? "NMT w punkcie obiektu",
    reliable: Boolean(level?.reliable),
  };
}

function midZ(z) { return z.length ? Number(z[Math.floor(z.length / 2)].toFixed(2)) : null; }

/** Kolizja jest potwierdzona wyłącznie przy wiarygodnych poziomach obu obiektów. */
export function physicalStatus(levelA, levelB, clearanceMeters = 2) {
  if (levelA?.reliable && levelB?.reliable) {
    const separated = Math.abs(levelA.zAtCrossing - levelB.zAtCrossing) > clearanceMeters;
    return separated ? "rozdzielone" : "potwierdzona";
  }
  return "podejrzenie";
}

export function evaluateDiagnostics(states, index) {
  const issues = [];
  const stats = { crossings2d: 0, sharedNode: 0, separatedByTags: 0, confirmedPhysical: 0, suspectedPhysical: 0 };
  const reportedKeys = new Set();
  // Para obiektów przecinająca się wielokrotnie jest jednym problemem.
  const push = (issue) => {
    const key = `${issue.code}:${[...issue.objects].sort().join("+")}`;
    if (reportedKeys.has(key)) return;
    reportedKeys.add(key);
    issues.push({ ...issue, key });
  };
  const location = (state) => {
    const f = state.feature;
    if (f.point) return f.point;
    if (f.anchor) return f.anchor;
    const i = Math.floor(f.points.length / 6) * 3;
    return [f.points[i], f.points[i + 1], f.points[i + 2] ?? 0];
  };

  for (const state of states.values()) {
    const { interp, feature } = state;
    const where = location(state);
    for (const issue of interp.issues) {
      push({ code: issue.checkId, category: issue.category, status: "informacja", severity: issue.severity, confidence: issue.confidence, message: issue.message, objects: [feature.id], location: where, suggest: issue.suggest, source: issue.source, reason: `Reguła kontroli ${issue.checkId}` });
    }
    for (const warning of interp.warnings) {
      push({ code: `value:${warning.key}`, category: "uncertain", status: "informacja", severity: 1, confidence: "wysoka", message: warning.message, objects: [feature.id], location: where, suggest: [], reason: "Walidacja wartości; edycja nie jest blokowana." });
    }
    for (const note of interp.uncertainties) {
      if (note.code === "roof-default") continue;
      push({ code: note.code, category: "uncertain", status: "informacja", severity: 1, confidence: "wysoka", message: note.message, objects: [feature.id], location: where, suggest: [], reason: "Interpretacja profilu" });
    }
    if (feature.incompleteMembers) {
      push({ code: "relation-incomplete", category: "missing", status: "informacja", severity: 2, confidence: "wysoka", message: `Relacja ma ${feature.incompleteMembers} niedostępnych lub niekompletnych członków; pokazano część geometrii.`, objects: [feature.id], location: where, suggest: [], reason: "Składanie multipolygonu" });
    }
  }

  for (const crossing of index.crossings) {
    const a = states.get(crossing.a), b = states.get(crossing.b);
    if (!a || !b) continue;
    const kindA = a.interp.classDef.levelCheck, kindB = b.interp.classDef.levelCheck;
    if (!kindA || !kindB || kindA === "none" || kindB === "none") continue;
    if (kindA === "water" && kindB === "water") continue;
    stats.crossings2d += 1;
    if (crossing.sharedNode && kindA === "transport" && kindB === "transport") { stats.sharedNode += 1; continue; }
    const where = [crossing.x, crossing.y, a.level ? midZ(a.level.z) : 0];
    const levels = [describeLevel(a), describeLevel(b)];
    const severity = Math.min(a.interp.classDef.impact ?? 1, b.interp.classDef.impact ?? 1);
    const objects = [crossing.a, crossing.b];

    if (kindA === "water" || kindB === "water") {
      const road = kindA === "water" ? b : a, water = kindA === "water" ? a : b;
      if (road.interp.attributes.structure === "bridge" || passesUnder(road.interp) || passesUnder(water.interp) || road.interp.attributes.waterCrossing) {
        stats.separatedByTags += 1;
      } else {
        stats.suspectedPhysical += 1;
        push({ code: "water-crossing", category: "physical", status: "podejrzenie", severity, confidence: "średnia", message: "Trasa przecina ciek bez oznaczenia mostu, przepustu ani brodu.", reason: "Przecięcie 2D bez tagów bridge/tunnel/ford; rzędna wody nie jest znana.", objects, location: where, levels, suggest: [] });
      }
      continue;
    }

    const orderA = order(a.interp), orderB = order(b.interp);
    const structureA = a.interp.attributes.structure, structureB = b.interp.attributes.structure;
    if (orderA.value === null || orderB.value === null) {
      if (orderA.value === null && orderB.value === null) {
        push({ code: "unknown-order", category: "uncertain", status: "podejrzenie", severity, confidence: "niska", message: "Dwa obiekty mostowe lub tunelowe bez layer: kolejność w przecięciu nieustalona.", reason: "Brak tagów layer po obu stronach.", objects, location: where, levels, suggest: [] });
      } else {
        stats.separatedByTags += 1;
      }
      continue;
    }
    if (orderA.value !== orderB.value) { stats.separatedByTags += 1; continue; }
    if (passesUnder(a.interp) || passesUnder(b.interp) || (structureA === "bridge") !== (structureB === "bridge")) {
      push({ code: "same-layer-structure", category: "uncertain", status: "podejrzenie", severity, confidence: "niska", message: "Obiekty o różnej konstrukcji mają ten sam layer: kolejność w przecięciu jest niejasna.", reason: "Równe wartości layer przy moście lub tunelu.", objects, location: where, levels, suggest: [] });
      continue;
    }
    const status = physicalStatus(a.level, b.level);
    if (status === "rozdzielone") { stats.separatedByTags += 1; continue; }
    if (status === "potwierdzona") stats.confirmedPhysical += 1; else stats.suspectedPhysical += 1;
    push({ code: "same-level-crossing", category: "physical", status, severity, confidence: status === "potwierdzona" ? "wysoka" : "średnia", message: "Przecięcie na tym samym poziomie bez wspólnego węzła.", reason: "Równe layer, brak mostu lub tunelu i brak wspólnego węzła. Poziomy nie pochodzą z pomiaru obiektu, więc wynik pozostaje podejrzeniem.", objects, location: where, levels, suggest: [] });
  }

  for (const crossing of index.crossings) {
    const a = states.get(crossing.a), b = states.get(crossing.b);
    if (!a || !b) continue;
    const [line, area] = a.interp.classDef.render === "extrude" ? [b, a] : [a, b];
    if (area.interp.classDef.render !== "extrude" || line.interp.classDef.levelCheck !== "transport") continue;
    if (line.tagsNow.indoor || passesUnder(line.interp) || line.interp.attributes.structure || (line.interp.attributes.layer ?? 0) !== (area.interp.attributes.layer ?? 0)) continue;
    push({ code: "line-through-building", category: "physical", status: "podejrzenie", severity: line.interp.classDef.impact ?? 1, confidence: "niska", message: "Trasa przecina obrys budynku bez oznaczenia przejścia.", reason: "Przecięcie 2D na tym samym layer; brak tunnel, covered lub indoor.", objects: [line.feature.id, area.feature.id], location: [crossing.x, crossing.y, location(area)[2]], levels: [describeLevel(line), describeLevel(area)], suggest: [{ key: "tunnel=building_passage", reason: "Gdy trasa rzeczywiście przechodzi przez budynek.", doc: "https://wiki.openstreetmap.org/wiki/Tag:tunnel%3Dbuilding_passage" }] });
  }

  const reported = new Set();
  for (const overlap of index.overlaps) {
    const a = states.get(overlap.inner), b = states.get(overlap.outer);
    if (!a || !b || a.interp.classId !== "building.main" || b.interp.classId !== "building.main") continue;
    const key = [overlap.inner, overlap.outer].sort().join("|");
    if (reported.has(key)) continue;
    reported.add(key);
    stats.suspectedPhysical += 1;
    push({ code: "building-overlap", category: "physical", status: "podejrzenie", severity: 1, confidence: "niska", message: "Obrysy dwóch budynków nakładają się.", reason: "Wierzchołek obrysu leży ponad 0,3 m wewnątrz drugiego budynku; wspólne granice nie są zgłaszane.", objects: [overlap.inner, overlap.outer], location: [overlap.x, overlap.y, location(a)[2]], levels: [describeLevel(a), describeLevel(b)], suggest: [] });
  }

  for (const near of index.proximity) {
    const point = states.get(near.point), line = states.get(near.line);
    if (!point || !line || !point.interp.classDef.contextObstacle || !line.interp.classDef.carriageway) continue;
    if (line.feature.nodeRefs.includes(point.feature.osmId)) continue;
    const width = line.interp.dimensions.width;
    if (!width || near.distance >= width.value / 2) continue;
    if (line.interp.attributes.structure || (line.interp.attributes.layer ?? 0) !== (point.interp.attributes.layer ?? 0)) continue;
    push({ code: "object-in-carriageway", category: "context", status: "podejrzenie", severity: point.interp.classDef.impact ?? 1, confidence: width.approximate ? "niska" : "średnia", message: `${point.interp.classDef.label} w obrysie jezdni (${near.distance.toFixed(1)} m od osi, połowa szerokości ${(width.value / 2).toFixed(1)} m).`, reason: `Szerokość: ${width.source}. Dokładność położenia punktu OSM nie jest znana, więc wynik pozostaje podejrzeniem.`, objects: [point.feature.id, line.feature.id], location: point.feature.point, levels: [describeLevel(point), describeLevel(line)], suggest: [{ key: "width", reason: "Zmierzona szerokość jezdni zmniejsza niepewność.", doc: "https://wiki.openstreetmap.org/wiki/Key:width" }] });
  }

  for (const gap of index.endGaps) {
    const way = states.get(gap.way), other = states.get(gap.other);
    if (!way || !other || way.interp.classDef.levelCheck !== "transport" || other.interp.classDef.levelCheck !== "transport") continue;
    if ((way.interp.attributes.layer ?? 0) !== (other.interp.attributes.layer ?? 0)) continue;
    const roads = way.interp.classDef.carriageway && other.interp.classDef.carriageway;
    push({ code: "topology-gap", category: "uncertain", status: "informacja", severity: roads ? 2 : 1, confidence: "średnia", message: `Koniec trasy leży ${gap.distance.toFixed(1)} m od innej trasy, ale nie mają wspólnego węzła.`, reason: "Topologia OSM: renderer nie dosuwa geometrii. To może być prawdziwy brak połączenia albo błąd danych; trzeba to ocenić w edytorze OSM.", objects: [gap.way, gap.other], location: [gap.x, gap.y, gap.z], levels: [describeLevel(way), describeLevel(other)], suggest: [] });
  }
  for (const pair of index.coincidentNodes) {
    const way = states.get(pair.way), other = states.get(pair.other);
    if (!way || !other || way.interp.classDef.levelCheck !== "transport" || other.interp.classDef.levelCheck !== "transport") continue;
    if ((way.interp.attributes.layer ?? 0) !== (other.interp.attributes.layer ?? 0)) continue;
    push({ code: "coincident-nodes", category: "uncertain", status: "informacja", severity: 1, confidence: "wysoka", message: `Dwie trasy mają osobne węzły oddalone o ${pair.distance.toFixed(2)} m.`, reason: "Topologia OSM: wygląda to jak połączenie, ale węzły nie są wspólne. Renderer ich nie scala.", objects: [pair.way, pair.other], location: [pair.x, pair.y, pair.z], levels: [describeLevel(way), describeLevel(other)], suggest: [] });
  }

  for (const pair of index.contained) {
    const line = states.get(pair.line), area = states.get(pair.area);
    if (!line || !area || area.interp.classId !== "structure.bridge" || line.interp.attributes.structure !== "bridge") continue;
    const own = line.tagsNow["bridge:structure"], outline = area.tagsNow["bridge:structure"];
    if (own && outline && own !== outline) {
      push({ code: "bridge-structure-mismatch", category: "uncertain", status: "informacja", severity: 2, confidence: "wysoka", message: `Sprzeczny typ konstrukcji: odcinek ma bridge:structure=${own}, a obrys mostu ${outline}.`, reason: "Oba obiekty leżą w tym samym moście; dane nie rozstrzygają, która wartość jest poprawna.", objects: [pair.line, pair.area], location: [pair.x, pair.y, location(line)[2]], levels: [describeLevel(line), describeLevel(area)], suggest: [{ key: "bridge:structure", reason: "Ujednolicić po sprawdzeniu w terenie lub dokumentacji mostu.", doc: "https://wiki.openstreetmap.org/wiki/Key:bridge:structure" }] });
    }
  }
  stats.confirmedPhysical = issues.filter((i) => i.category === "physical" && i.status === "potwierdzona").length;
  stats.suspectedPhysical = issues.filter((i) => i.category === "physical" && i.status === "podejrzenie").length;
  return { issues, stats };
}

export const severityLabel = { 3: "wysoka", 2: "średnia", 1: "niska" };
