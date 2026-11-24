// Model pionowy sieci. Węzeł OSM ma jedną wysokość, wspólną dla wszystkich dochodzących do niego tras.
// Wynik służy prezentacji i pozostaje przybliżony: NMT nie zawiera mostów, a `layer` nie jest wysokością.

import { finishSteps, pointInRing } from "./diagnostics.js";

export const LEVEL_METHOD = {
  ground: "NMT w osi obiektu",
  road: "NMT w osi, z ograniczeniem spadku w sieci tras",
  bridge: "pomost: wysokość przyczółków z NMT + wymagany prześwit nad przecinanymi obiektami",
  tunnel: "tunel: wysokość wlotów z NMT − wymagany odstęp pod przecinanymi obiektami",
};

const LOW_ORDER = -100;
const WATER_MARGIN = 1;
const DECK_BIN_METERS = 12;
// Wgłębienia profilu trasy węższe niż 2 × 20 m i płytsze niż 2,5 m są artefaktem NMT (rów, ciek pod przepustem, cień mostu), nie niweletą drogi.
const DIP_RADIUS_METERS = 20, DIP_MAX_METERS = 2.5, RAISED_OFFSET_METERS = 0.4;
const LATERAL_CELL = 12, LATERAL_MARGIN = 0.8, MIN_PARALLEL_COS = 0.6, MAX_GROUND_DIFFERENCE = 1, CROSS_GRADE = 0.02, MAX_ALONG_OFFSET = 9;

export function levelSignature(interp) {
  const { attributes, classId, classDef } = interp;
  return `${classDef.render}|${classDef.levelCheck ?? ""}|${classId}|${attributes.structure ?? ""}|${attributes.layer ?? ""}`;
}

// Klucz liczbowy komórki siatki (całkowite indeksy do ±2^20).
const cellKey = (i, j) => (i + 1048576) * 2097152 + (j + 1048576);

function groundProfile(points) {
  const count = points.length / 3;
  const z = new Float32Array(count);
  let last = NaN;
  for (let i = 0; i < count; i += 1) {
    const value = points[i * 3 + 2];
    if (value !== null) last = value;
    z[i] = value ?? last;
  }
  last = NaN;
  for (let i = count - 1; i >= 0; i -= 1) {
    if (Number.isNaN(z[i])) z[i] = last;
    else last = z[i];
  }
  return z;
}

class MaxHeap {
  constructor() { this.values = []; this.ids = []; }
  get size() { return this.values.length; }
  push(value, id) {
    const { values, ids } = this;
    let i = values.length;
    values.push(value); ids.push(id);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (values[parent] >= value) break;
      values[i] = values[parent]; ids[i] = ids[parent];
      i = parent;
    }
    values[i] = value; ids[i] = id;
  }
  /** Zdejmuje wierzchołek: zwraca jego id, a wartość zostawia w topValue (bez tworzenia tablicy na każde zdjęcie). */
  pop() {
    const { values, ids } = this;
    this.topValue = values[0];
    const top = ids[0];
    const value = values.pop(), id = ids.pop();
    const n = values.length;
    if (n) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && values[child + 1] > values[child]) child += 1;
        if (values[child] <= value) break;
        values[i] = values[child]; ids[i] = ids[child];
        i = child;
      }
      values[i] = value; ids[i] = id;
    }
    return top;
  }
}

/**
 * Górna obwiednia: max po źródłach t z (wartość(t) − koszt(t, v)). Koszt to długość × dopuszczalny spadek.
 * floor: wartości poniżej nie są propagowane (zostaje −∞); wzdłuż ścieżki wartość tylko maleje, więc nie wpływa to na
 * żaden punkt, w którym wynik jest porównywany z wysokością nie mniejszą niż floor.
 */
function upperEnvelope(adjacency, seeds, floor = -Infinity) {
  const out = new Float64Array(adjacency.length).fill(-Infinity);
  const heap = new MaxHeap();
  seeds.forEach((value, id) => { if (Number.isFinite(value)) { out[id] = value; heap.push(value, id); } });
  while (heap.size) {
    const id = heap.pop(), value = heap.topValue;
    if (value < out[id]) continue;
    for (const [to, cost] of adjacency[id]) {
      const next = value - cost;
      if (next > out[to] && next >= floor) { out[to] = next; heap.push(next, to); }
    }
  }
  return out;
}
const lowerEnvelope = (adjacency, seeds, ceiling = Infinity) => upperEnvelope(adjacency, seeds.map((v) => -v), -ceiling).map((v) => -v);

function locate(feature, x, y) {
  const { nodeIndex, points } = feature;
  let best = { index: 1, t: 0, distance: Infinity };
  for (let i = 1; i < nodeIndex.length; i += 1) {
    const a = nodeIndex[i - 1] * 3, b = nodeIndex[i] * 3;
    const ax = points[a], ay = points[a + 1], dx = points[b] - ax, dy = points[b + 1] - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    const distance = Math.hypot(x - ax - t * dx, y - ay - t * dy);
    if (distance < best.distance) best = { index: i, t, distance };
  }
  return best;
}

/**
 * Wypełnia krótkie wgłębienia profilu tras, które NMT tworzy pod drogą w rowach, nad ciekami w przepustach i przy mostach.
 * Punkt jest podnoszony tylko wtedy, gdy w promieniu 20 m wzdłuż sieci po co najmniej dwóch stronach (różnymi odcinkami)
 * leży wyższy punkt: do niższej z tych dwóch wysokości. Koniec trasy, wlot tunelu i rampa schodząca do konstrukcji
 * nie są więc podnoszone. Wysokość tylko rośnie, a wgłębienie głębsze niż 2,5 m zostaje (może być przejazdem pod konstrukcją).
 */
function fillRoadDips(ways, heights, tunnelVertices, fixed = new Set()) {
  const edges = new Map(), link = (a, b, l) => { if (!edges.has(a)) edges.set(a, []); edges.get(a).push([b, l]); };
  for (const way of ways) {
    // Jezdnie, ścieżki i chodniki; schody mają własny profil stopni.
    if (!way.interp.classDef.surfaced || way.interp.classDef.stairs) continue;
    const { points } = way.feature;
    for (let k = 1; k < way.vertices.length; k += 1) {
      const a = way.vertices[k - 1], b = way.vertices[k], l = Math.hypot(points[k * 3] - points[k * 3 - 3], points[k * 3 + 1] - points[k * 3 - 2]);
      if (a !== b) { link(a, b, l); link(b, a, l); }
    }
  }
  // Najwyższy punkt osiągalny z `from` (po odcinku od v) w pozostałym promieniu, bez przechodzenia przez v.
  const sideMax = (v, from, first) => {
    if (first > DIP_RADIUS_METERS) return -Infinity;
    const best = new Map([[from, first]]), queue = [[first, from]];
    let top = Number.isFinite(heights[from]) ? heights[from] : -Infinity;
    while (queue.length) {
      queue.sort((p, q) => p[0] - q[0]);
      const [d, u] = queue.shift();
      if (d > best.get(u)) continue;
      for (const [to, l] of edges.get(u) ?? []) {
        const next = d + l;
        if (to === v || next > DIP_RADIUS_METERS || next >= (best.get(to) ?? Infinity)) continue;
        best.set(to, next); queue.push([next, to]);
        if (Number.isFinite(heights[to])) top = Math.max(top, heights[to]);
      }
    }
    return top;
  };
  // Rampa do tunelu lub przejścia podziemnego jest rzeczywistym obniżeniem: punkty w promieniu 20 m od węzła tunelu zostają.
  const protectedNear = new Set();
  for (const start of tunnelVertices) {
    const best = new Map([[start, 0]]), queue = [[0, start]];
    while (queue.length) {
      queue.sort((p, q) => p[0] - q[0]);
      const [d, u] = queue.shift();
      if (d > best.get(u)) continue;
      protectedNear.add(u);
      for (const [to, l] of edges.get(u) ?? []) if (d + l <= DIP_RADIUS_METERS && d + l < (best.get(to) ?? Infinity)) { best.set(to, d + l); queue.push([d + l, to]); }
    }
  }
  const out = heights.slice();
  for (const [v, list] of edges) {
    if (fixed.has(v) || protectedNear.has(v) || list.length < 2 || !Number.isFinite(heights[v])) continue;
    const sides = list.map(([to, l]) => sideMax(v, to, l)).sort((p, q) => q - p);
    const target = sides[1];
    if (target > heights[v] && target - heights[v] <= DIP_MAX_METERS) out[v] = target;
  }
  return out;
}

/** Graf sieci: odcinki naziemne w gęstych punktach, konstrukcje tylko jako połączenia między swoimi węzłami. */
function buildPlainGraph(ways, structures) {
  const adjacency = [], heights = [], nodeVertex = new Map(), plainRefs = new Set();
  const vertex = (height) => { adjacency.push([]); heights.push(height); return adjacency.length - 1; };
  for (const way of ways) {
    for (const ref of way.feature.nodeRefs) plainRefs.add(ref);
    const { nodeRefs, nodeIndex, points } = way.feature;
    const refAt = new Map(nodeIndex.map((k, i) => [k, nodeRefs[i]]));
    way.vertices = new Int32Array(way.ground.length);
    for (let k = 0; k < way.ground.length; k += 1) {
      const ref = refAt.get(k);
      let id = ref === undefined ? undefined : nodeVertex.get(ref);
      if (id === undefined) {
        id = vertex(way.ground[k]);
        if (ref !== undefined) nodeVertex.set(ref, id);
      }
      way.vertices[k] = id;
      if (k > 0) {
        const previous = way.vertices[k - 1];
        const length = Math.hypot(points[k * 3] - points[k * 3 - 3], points[k * 3 + 1] - points[k * 3 - 2]);
        const cost = length * way.grade;
        adjacency[id].push([previous, cost]);
        adjacency[previous].push([id, cost]);
      }
    }
  }
  // Wnętrze konstrukcji nie ma wiarygodnego gruntu, ale spadek między jej końcami nadal obowiązuje.
  for (const way of structures) {
    const { nodeRefs, nodeIndex, points } = way.feature;
    let previous = null;
    nodeRefs.forEach((ref, i) => {
      let id = nodeVertex.get(ref);
      if (id === undefined) { id = vertex(NaN); nodeVertex.set(ref, id); }
      if (previous !== null) {
        const a = nodeIndex[i - 1] * 3, b = nodeIndex[i] * 3;
        const cost = Math.hypot(points[b] - points[a], points[b + 1] - points[a + 1]) * way.grade;
        adjacency[id].push([previous, cost]);
        adjacency[previous].push([id, cost]);
      }
      previous = id;
    });
  }
  return { adjacency, heights, nodeVertex, plainRefs };
}

/**
 * Jezdnie stykające się bokiem tworzą jedną nawierzchnię, jeśli mają ten sam poziom i podobny grunt.
 * Ścieżki i drogi na wyraźnie innym terenie pozostają niezależne, więc nie są „sklejane” przez samą bliskość.
 */
function addLateralLinks(ways, plain, order) {
  const roads = ways.filter((w) => w.kind !== "tunnel" && w.kind !== "other" && w.interp.classDef.carriageway);
  const grid = new Map(), samples = [];
  for (const way of roads) {
    const { points } = way.feature, count = way.ground.length;
    // Założona szerokość pasa służy tylko do rysowania: nie może przesuwać wyznaczonych poziomów.
    const width = way.interp.dimensions.width;
    way.halfWidth = ((width?.basis === "lanes" ? null : width?.value) ?? way.interp.classDef.widthMeters ?? 2) / 2;
    way.order = order(way);
    for (let k = 0; k < count; k += 1) {
      const p = Math.max(0, k - 1), q = Math.min(count - 1, k + 1);
      let tx = points[q * 3] - points[p * 3], ty = points[q * 3 + 1] - points[p * 3 + 1];
      const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      const sample = { way, k, x: points[k * 3], y: points[k * 3 + 1], tx, ty };
      samples.push(sample);
      const key = cellKey(Math.floor(sample.x / LATERAL_CELL), Math.floor(sample.y / LATERAL_CELL));
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(sample);
    }
  }
  const vertexOf = ({ way, k }) => {
    if (way.kind === "plain") return way.vertices[k];
    const { nodeIndex, nodeRefs } = way.feature;
    let nearest = 0;
    nodeIndex.forEach((index, i) => { if (Math.abs(index - k) < Math.abs(nodeIndex[nearest] - k)) nearest = i; });
    return plain.nodeVertex.get(nodeRefs[nearest]);
  };
  const refOfBridge = ({ way, k }, refs) => {
    if (way.kind !== "bridge") return;
    const { nodeIndex, nodeRefs } = way.feature;
    let nearest = 0;
    nodeIndex.forEach((index, i) => { if (Math.abs(index - k) < Math.abs(nodeIndex[nearest] - k)) nearest = i; });
    refs.add(nodeRefs[nearest]);
  };
  const bridgeRefs = new Set();
  for (const a of samples) {
    const best = new Map();
    const cx = Math.floor(a.x / LATERAL_CELL), cy = Math.floor(a.y / LATERAL_CELL);
    for (let i = cx - 2; i <= cx + 2; i += 1) for (let j = cy - 2; j <= cy + 2; j += 1) {
      for (const b of grid.get(cellKey(i, j)) ?? []) {
        if (b.way === a.way || b.way.feature.id < a.way.feature.id || b.way.order !== a.way.order) continue;
        if (Math.abs(a.tx * b.tx + a.ty * b.ty) < MIN_PARALLEL_COS) continue;
        // Punkty osi leżą co kilkanaście metrów, dlatego styk ocenia się w poprzek jezdni, a nie po prostej między nimi.
        const dx = b.x - a.x, dy = b.y - a.y, along = Math.abs(dx * a.tx + dy * a.ty), across = Math.abs(dy * a.tx - dx * a.ty);
        if (along > MAX_ALONG_OFFSET || across > a.way.halfWidth + b.way.halfWidth + LATERAL_MARGIN) continue;
        const distance = Math.hypot(dx, dy);
        const onDeck = a.way.kind === "bridge" || b.way.kind === "bridge";
        if (!onDeck && Math.abs(a.way.ground[a.k] - b.way.ground[b.k]) > MAX_GROUND_DIFFERENCE) continue;
        if (distance < (best.get(b.way)?.distance ?? Infinity)) best.set(b.way, { b, distance });
      }
    }
    for (const { b, distance } of best.values()) {
      const va = vertexOf(a), vb = vertexOf(b);
      if (va === undefined || vb === undefined || va === vb) continue;
      const cost = distance * CROSS_GRADE;
      plain.adjacency[va].push([vb, cost]);
      plain.adjacency[vb].push([va, cost]);
      refOfBridge(a, bridgeRefs); refOfBridge(b, bridgeRefs);
    }
  }
  return bridgeRefs;
}

/** Rozwiązuje pomosty (sign=1) albo tunele (sign=-1); dla tuneli działa na wysokościach ze zmienionym znakiem. */
function solveStructures(ways, sign, context) {
  const { step, plainZ, plain, otherZ, required } = context;
  const nodes = new Map();
  const touch = (ref, height) => {
    if (!nodes.has(ref)) nodes.set(ref, { id: nodes.size, ref, height, edges: [] });
    return nodes.get(ref);
  };
  for (const way of ways) {
    const { nodeRefs, nodeIndex, points } = way.feature;
    for (let i = 0; i < nodeRefs.length; i += 1) {
      const node = touch(nodeRefs[i], way.ground[nodeIndex[i]]);
      if (i === 0) continue;
      const from = nodeIndex[i - 1] * 3, to = nodeIndex[i] * 3;
      const dx = points[to] - points[from], dy = points[to + 1] - points[from + 1];
      const length = Math.hypot(dx, dy) || 0.01;
      const previous = nodes.get(nodeRefs[i - 1]);
      previous.edges.push({ to: node.id, other: node.ref, length, cost: length * way.grade, ux: dx / length, uy: dy / length });
      node.edges.push({ to: previous.id, other: previous.ref, length, cost: length * way.grade, ux: -dx / length, uy: -dy / length });
    }
  }
  const list = [...nodes.values()];
  const adjacency = list.map((node) => node.edges.map((edge) => [edge.to, edge.cost]));
  for (const node of list) {
    const network = plainZ[plain.nodeVertex.get(node.ref)];
    const outside = otherZ.get(node.ref) ?? (Number.isFinite(network) ? network : node.height);
    node.outer = sign * outside;
    node.surface = sign * node.height;
    // Węzeł przelotowy ma dwa odcinki po przeciwnych stronach; rozwidlenie przy przyczółku nim nie jest.
    const through = node.edges.some((a) => node.edges.some((b) => a.other !== b.other && a.ux * b.ux + a.uy * b.uy < -0.5));
    node.boundary = !through;
    node.value = node.boundary ? node.outer : node.surface;
  }
  for (let sweep = 0; sweep < 300; sweep += 1) {
    const order = sweep % 2 ? list : [...list].reverse();
    for (const node of order) {
      if (node.boundary || !node.edges.length) continue;
      let weight = 0, total = 0;
      for (const edge of node.edges) { const w = 1 / edge.length; weight += w; total += w * list[edge.to].value; }
      node.value += 1.7 * (total / weight - node.value);
    }
  }
  const reachable = lowerEnvelope(adjacency, list.map((n) => (n.boundary ? n.outer : NaN)));
  const hard = upperEnvelope(adjacency, list.map((n) => required.get(n.ref) ?? NaN));
  const targets = list.map((node, i) => {
    if (node.boundary) return Math.max(node.outer, hard[i]);
    const clearance = Math.min(node.surface + step, reachable[i]);
    return Math.max(node.value, clearance, hard[i]);
  });
  const limited = upperEnvelope(adjacency, targets);
  const result = new Map();
  list.forEach((node, i) => result.set(node.ref, sign * (node.boundary ? targets[i] : limited[i])));
  return { z: result, nodes };
}

/**
 * @param items obiekty liniowe {feature, interp}
 * @param vertical parametry profilu: layerStepMeters to wymagany prześwit, a jego stosunek do rampMeters to spadek
 * @param crossings przecięcia 2D z indeksu przestrzennego
 */
export function computeLevels(items, vertical, crossings = []) { return finishSteps(computeLevelsSteps(items, vertical, crossings)); }

/** Poziomy etapami: yield między fazami (graf sieci, obwiednie, rundy konstrukcji) przy doczytywaniu kafli. */
export function* computeLevelsSteps(items, vertical, crossings = []) {
  const step = vertical.layerStepMeters;
  const defaultGrade = step / vertical.rampMeters;
  const result = new Map();
  const ways = new Map();
  for (const item of items) {
    if (item.interp.geometry !== "line" || item.feature.geometry !== "way") continue;
    const ground = groundProfile(item.feature.points);
    result.set(item.feature.id, { z: ground, method: LEVEL_METHOD.ground, lifted: false, units: 0, reliable: false, maxOffset: 0 });
    const { classDef, attributes } = item.interp;
    const transport = classDef.levelCheck === "transport";
    const kind = transport ? (attributes.structure === "bridge" ? "bridge" : attributes.structure === "tunnel" ? "tunnel" : "plain") : "other";
    ways.set(item.feature.id, { ...item, ground, kind, grade: classDef.maxGrade ?? defaultGrade });
  }
  const all = [...ways.values()];
  const plainWays = all.filter((w) => w.kind === "plain");
  const bridges = all.filter((w) => w.kind === "bridge");
  const tunnels = all.filter((w) => w.kind === "tunnel");

  const order = (way) => {
    const { layer, structure } = way.interp.attributes;
    if (layer !== undefined) return layer;
    if (structure === "bridge") return vertical.assumedBridgeLayer;
    if (structure === "tunnel") return -vertical.assumedBridgeLayer;
    return way.kind === "other" ? LOW_ORDER : 0;
  };

  // Teren pod drogą: najbliższy profil o dopuszczalnym spadku. Tam, gdzie NMT go spełnia, pozostaje bez zmian.
  yield "poziomy: profile";
  const plain = buildPlainGraph(plainWays, [...bridges, ...tunnels]);
  const lateralBridgeRefs = addLateralLinks(all, plain, order);
  const upper = upperEnvelope(plain.adjacency, plain.heights);
  const lower = lowerEnvelope(plain.adjacency, plain.heights);
  const envelope = plain.heights.map((h, i) => (Number.isFinite(upper[i]) && Number.isFinite(lower[i]) ? (upper[i] + lower[i]) / 2 : h));
  // Węzły tuneli w grafie sieci: rampy przy nich nie są wygładzane.
  const tunnelVertices = new Set(tunnels.flatMap((w) => w.feature.nodeRefs).map((ref) => plain.nodeVertex.get(ref)).filter((v) => v !== undefined));
  yield "poziomy: obwiednie";
  const basePlain = fillRoadDips(plainWays, envelope, tunnelVertices);
  // Wypełniony dołek NMT jest gruntem pod trasą (nasyp nad rowem lub przepustem), a nie nasypem konstrukcji: nie liczy się do maxOffset.
  const dipLift = basePlain.map((z, i) => (Number.isFinite(z) && Number.isFinite(envelope[i]) ? z - envelope[i] : 0));
  let plainZ = basePlain;

  // Sieć naziemna dochodzi do konstrukcji dokładnie na ich wysokości, z tym samym ograniczeniem spadku.
  // Zwraca też podłogę sieci: podniesiony pomost unosi sąsiednie przyczółki, zamiast tworzyć stromy łącznik.
  // Zasięg wysokości sieci: obwiednia od kotwic poniżej najniższego punktu (albo powyżej najwyższego) nie zmienia wyniku
  // min/max z wysokością gruntu, więc propagacja kończy się tam zamiast obejmować cały graf.
  let lowest = Infinity, highest = -Infinity;
  for (const z of basePlain) if (Number.isFinite(z)) { lowest = Math.min(lowest, z); highest = Math.max(highest, z); }
  // Te same kotwice dają ten sam wynik: kolejne rundy po ustaleniu się konstrukcji nie liczą obwiedni od nowa.
  let lastAnchors = null, lastAttach = null;
  const attachPlain = (structures) => {
    const anchors = new Array(basePlain.length).fill(NaN);
    for (const map of structures) {
      for (const [ref, z] of map) if (plain.plainRefs.has(ref)) anchors[plain.nodeVertex.get(ref)] = z;
    }
    if (lastAnchors && anchors.every((v, i) => Object.is(v, lastAnchors[i]))) return lastAttach;
    lastAnchors = anchors;
    lastAttach = attachAnchors(anchors);
    return lastAttach;
  };
  const attachAnchors = (anchors) => {
    if (!anchors.some(Number.isFinite)) return { attached: basePlain, floor: basePlain };
    let top = highest;
    for (const z of anchors) if (Number.isFinite(z)) top = Math.max(top, z);
    // high ma znaczenie tylko poniżej max(low, z) ≤ top; low tylko powyżej z ≥ lowest.
    const high = lowerEnvelope(plain.adjacency, anchors, top), low = upperEnvelope(plain.adjacency, anchors, lowest);
    return {
      attached: basePlain.map((z, i) => (Number.isFinite(anchors[i]) ? anchors[i] : Math.min(high[i], Math.max(low[i], z)))),
      floor: basePlain.map((z, i) => (Number.isFinite(z) ? Math.max(z, low[i]) : z)),
    };
  };
  let floor = basePlain;

  let bridgeZ = new Map(), tunnelZ = new Map();
  const zAt = (way, x, y) => {
    const { index, t } = locate(way.feature, x, y);
    const { nodeIndex, nodeRefs } = way.feature;
    if (way.kind === "bridge" || way.kind === "tunnel") {
      const map = way.kind === "bridge" ? bridgeZ : tunnelZ;
      const a = map.get(nodeRefs[index - 1]), b = map.get(nodeRefs[index]);
      if (a !== undefined && b !== undefined) return a + (b - a) * t;
    }
    const k = Math.round(nodeIndex[index - 1] + (nodeIndex[index] - nodeIndex[index - 1]) * t);
    return way.kind === "plain" ? plainZ[way.vertices[k]] : way.ground[k];
  };
  // Jezdnie w jednym obrysie man_made=bridge i na tym samym poziomie mają wspólną niweletę w poprzek mostu.
  yield "poziomy: dołki";
  const deckGroups = [];
  for (const item of items) {
    if (item.interp.classDef.render !== "structure" || item.interp.geometry !== "area" || item.feature.geometry !== "way") continue;
    const ring = [];
    for (let i = 0; i < item.feature.points.length; i += 3) ring.push(item.feature.points[i], item.feature.points[i + 1]);
    const byOrder = new Map();
    for (const way of bridges) {
      const { nodeRefs, nodeIndex, points } = way.feature;
      const nodes = nodeRefs.map((ref, i) => ({ ref, x: points[nodeIndex[i] * 3], y: points[nodeIndex[i] * 3 + 1] }));
      if (nodes.filter((n) => pointInRing(n.x, n.y, ring)).length < nodes.length * 0.6) continue;
      const key = order(way);
      if (item.interp.attributes.layer !== undefined && item.interp.attributes.layer !== key) continue;
      if (!byOrder.has(key)) byOrder.set(key, { ways: 0, nodes: new Map() });
      const group = byOrder.get(key);
      group.ways += 1;
      for (const node of nodes) group.nodes.set(node.ref, node);
    }
    for (const group of byOrder.values()) {
      if (group.ways < 2) continue;
      const nodes = [...group.nodes.values()];
      const cx = nodes.reduce((t, n) => t + n.x, 0) / nodes.length, cy = nodes.reduce((t, n) => t + n.y, 0) / nodes.length;
      let xx = 0, xy = 0, yy = 0;
      for (const n of nodes) { xx += (n.x - cx) ** 2; xy += (n.x - cx) * (n.y - cy); yy += (n.y - cy) ** 2; }
      const angle = Math.atan2(2 * xy, xx - yy) / 2, ux = Math.cos(angle), uy = Math.sin(angle);
      deckGroups.push(nodes.map((n) => ({ ref: n.ref, s: (n.x - cx) * ux + (n.y - cy) * uy })));
    }
  }
  const alignDecks = (need) => {
    for (const group of deckGroups) {
      const bins = new Map();
      for (const { ref, s } of group) {
        const z = bridgeZ.get(ref);
        if (z === undefined) continue;
        const bin = Math.round(s / DECK_BIN_METERS);
        bins.set(bin, Math.max(bins.get(bin) ?? -Infinity, z));
      }
      const keys = [...bins.keys()].sort((a, b) => a - b);
      if (!keys.length) continue;
      for (const { ref, s } of group) {
        const position = s / DECK_BIN_METERS;
        let upper = keys.findIndex((k) => k >= position);
        if (upper < 0) upper = keys.length - 1;
        const lower = Math.max(0, keys[upper] >= position && upper > 0 ? upper - 1 : upper);
        const a = keys[lower], b = keys[upper], t = b === a ? 0 : Math.max(0, Math.min(1, (position - a) / (b - a)));
        need.set(ref, Math.max(need.get(ref) ?? -Infinity, bins.get(a) + (bins.get(b) - bins.get(a)) * t));
      }
    }
  };

  const relevant = crossings.filter((c) => !c.sharedNode && ways.has(c.a) && ways.has(c.b))
    .map((c) => ({ ...c, wayA: ways.get(c.a), wayB: ways.get(c.b) }))
    .filter((c) => order(c.wayA) !== order(c.wayB) && [c.wayA.kind, c.wayB.kind].some((k) => k === "bridge" || k === "tunnel"));

  for (let round = 0; round < 6; round += 1) {
    yield "poziomy: konstrukcje";
    const needBridge = new Map(), needTunnel = new Map();
    const raise = (map, way, crossing, value) => {
      const { index } = locate(way.feature, crossing.x, crossing.y);
      for (const ref of [way.feature.nodeRefs[index - 1], way.feature.nodeRefs[index]]) map.set(ref, Math.max(map.get(ref) ?? -Infinity, value));
    };
    for (const crossing of relevant) {
      const [high, low] = order(crossing.wayA) > order(crossing.wayB) ? [crossing.wayA, crossing.wayB] : [crossing.wayB, crossing.wayA];
      // Prześwit drogowy dotyczy tras. Nad ciekiem wystarcza minimalny odstęp, bo rzędna wody nie jest znana.
      if (high.kind === "bridge") raise(needBridge, high, crossing, zAt(low, crossing.x, crossing.y) + (low.kind === "other" ? WATER_MARGIN : step));
      if (low.kind === "tunnel") raise(needTunnel, low, crossing, -(zAt(high, crossing.x, crossing.y) - step));
    }
    if (round > 0) {
      alignDecks(needBridge);
      for (const ref of lateralBridgeRefs) {
        const height = floor[plain.nodeVertex.get(ref)];
        if (Number.isFinite(height)) needBridge.set(ref, Math.max(needBridge.get(ref) ?? -Infinity, height));
      }
    }
    bridgeZ = solveStructures(bridges, 1, { step, plainZ: floor, plain, otherZ: tunnelZ, required: needBridge }).z;
    tunnelZ = solveStructures(tunnels, -1, { step, plainZ: basePlain, plain, otherZ: bridgeZ, required: needTunnel }).z;
    for (const ref of tunnelZ.keys()) if (bridgeZ.has(ref)) tunnelZ.set(ref, bridgeZ.get(ref));
    ({ attached: plainZ, floor } = attachPlain([bridgeZ, tunnelZ]));
  }

  yield "poziomy: konstrukcje";
  // Po dowiązaniu do konstrukcji między dwoma pomostami może zostać „V” z ograniczenia spadku; końce konstrukcji zostają na miejscu.
  const anchored = new Set([...bridgeZ.keys(), ...tunnelZ.keys()].map((ref) => plain.nodeVertex.get(ref)).filter((v) => v !== undefined));
  const beforeFill = plainZ;
  plainZ = fillRoadDips(plainWays, plainZ, tunnelVertices, anchored);
  plainZ.forEach((z, i) => { if (Number.isFinite(z) && Number.isFinite(beforeFill[i])) dipLift[i] += z - beforeFill[i]; });
  for (const way of plainWays) {
    const z = Float32Array.from(way.vertices, (id) => (Number.isFinite(plainZ[id]) ? plainZ[id] : plain.heights[id]));
    let maxOffset = 0;
    const offsets = Array.from(z, (v, i) => Math.abs(v - way.ground[i] - (dipLift[way.vertices[i]] ?? 0)));
    offsets.forEach((d) => { if (d > maxOffset) maxOffset = d; });
    // Długość odcinków leżących wyraźnie ponad terenem (oba końce odcinka ponad 0,4 m): odróżnia nasyp od lokalnego odchylenia.
    const p = way.feature.points;
    let raisedMeters = 0;
    for (let i = 1; i < offsets.length; i += 1) if (offsets[i - 1] > RAISED_OFFSET_METERS && offsets[i] > RAISED_OFFSET_METERS) raisedMeters += Math.hypot(p[i * 3] - p[i * 3 - 3], p[i * 3 + 1] - p[i * 3 - 2]);
    result.set(way.feature.id, { z, method: LEVEL_METHOD.road, lifted: false, units: 0, reliable: false, maxOffset, raisedMeters });
  }
  for (const [list, map, units, method] of [[bridges, bridgeZ, 1, LEVEL_METHOD.bridge], [tunnels, tunnelZ, -1, LEVEL_METHOD.tunnel]]) {
    for (const way of list) {
      const { nodeRefs, nodeIndex } = way.feature;
      const z = new Float32Array(way.ground.length);
      for (let i = 1; i < nodeRefs.length; i += 1) {
        const a = map.get(nodeRefs[i - 1]), b = map.get(nodeRefs[i]);
        const start = nodeIndex[i - 1], span = Math.max(1, nodeIndex[i] - start);
        for (let k = start; k <= nodeIndex[i]; k += 1) z[k] = a + ((b - a) * (k - start)) / span;
      }
      result.set(way.feature.id, { z, method, lifted: true, units, reliable: false, maxOffset: 0 });
    }
  }
  return result;
}
