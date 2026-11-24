// Niezależny audyt ciągłości sceny. Nie korzysta z solvera poziomów: ocenia wyłącznie jego wynik.

const isTransport = (state) => state.feature.geometry === "way" && state.interp.geometry === "line"
  && state.interp.classDef.levelCheck === "transport" && state.level;

function orderOf(interp) {
  const { layer, structure } = interp.attributes;
  if (layer !== undefined) return layer;
  if (structure === "bridge") return 1;
  if (structure === "tunnel") return -1;
  return 0;
}

function zNear(state, x, y) {
  const { points } = state.feature;
  let best = Infinity, z = null;
  for (let i = 0; i < points.length / 3; i += 1) {
    const d = (points[i * 3] - x) ** 2 + (points[i * 3 + 1] - y) ** 2;
    if (d < best) { best = d; z = state.level.z[i]; }
  }
  return z;
}

function distanceToWay(state, x, y) {
  const { points } = state.feature;
  let best = Infinity;
  for (let i = 3; i < points.length; i += 3) {
    const ax = points[i - 3], ay = points[i - 2], dx = points[i] - ax, dy = points[i + 1] - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

export function auditContinuity(model, { jumpTolerance = 0.05, maxGrade = null, gapMeters = 4, minClearance = 4 } = {}) {
  const lines = [...model.states.values()].filter(isTransport);
  const { layerStepMeters, rampMeters } = model.profile.vertical;
  const gradeLimit = (state) => maxGrade ?? (state.interp.classDef.maxGrade ?? layerStepMeters / rampMeters) * 1.02;
  const nodes = new Map();
  for (const state of lines) {
    const { nodeRefs, nodeIndex, points } = state.feature;
    nodeRefs.forEach((ref, i) => {
      const k = nodeIndex[i];
      if (!nodes.has(ref)) nodes.set(ref, { x: points[k * 3], y: points[k * 3 + 1], uses: [] });
      nodes.get(ref).uses.push({ id: state.feature.id, z: state.level.z[k], end: i === 0 || i === nodeRefs.length - 1 });
    });
  }

  const jumps = [];
  for (const [ref, node] of nodes) {
    const values = node.uses.map((u) => u.z).filter(Number.isFinite);
    if (values.length < 2) continue;
    const size = Math.max(...values) - Math.min(...values);
    if (size > jumpTolerance) jumps.push({ node: ref, size: +size.toFixed(2), x: Math.round(node.x), y: Math.round(node.y), ways: node.uses.map((u) => u.id) });
  }
  jumps.sort((a, b) => b.size - a.size);

  const steep = [];
  for (const state of lines) {
    const { points } = state.feature, { z } = state.level;
    let worst = 0, at = 0;
    for (let i = 1; i < z.length; i += 1) {
      const run = Math.hypot(points[i * 3] - points[i * 3 - 3], points[i * 3 + 1] - points[i * 3 - 2]);
      if (run < 1) continue;
      const grade = Math.abs(z[i] - z[i - 1]) / run;
      if (grade > worst) { worst = grade; at = i; }
    }
    if (worst > gradeLimit(state)) steep.push({ id: state.feature.id, cls: state.interp.classId, grade: +worst.toFixed(3), lifted: state.level.lifted, x: Math.round(points[at * 3]), y: Math.round(points[at * 3 + 1]) });
  }
  steep.sort((a, b) => b.grade - a.grade);

  // Topologia OSM: koniec trasy tuż przy innej trasie, ale bez wspólnego węzła.
  const gaps = [];
  const cell = 40, grid = new Map();
  for (const state of lines) {
    const { points } = state.feature;
    for (let i = 0; i < points.length; i += 3) {
      const key = `${Math.floor(points[i] / cell)}:${Math.floor(points[i + 1] / cell)}`;
      if (!grid.has(key)) grid.set(key, new Set());
      grid.get(key).add(state);
    }
  }
  for (const [ref, node] of nodes) {
    if (node.uses.length !== 1 || !node.uses[0].end) continue;
    const owner = model.states.get(node.uses[0].id);
    const cx = Math.floor(node.x / cell), cy = Math.floor(node.y / cell);
    let best = null;
    for (let i = cx - 1; i <= cx + 1; i += 1) for (let j = cy - 1; j <= cy + 1; j += 1) {
      for (const other of grid.get(`${i}:${j}`) ?? []) {
        if (other === owner || other.feature.nodeRefs.includes(ref)) continue;
        const d = distanceToWay(other, node.x, node.y);
        if (d <= gapMeters && (!best || d < best.distance)) best = { other: other.feature.id, distance: +d.toFixed(2) };
      }
    }
    if (best) gaps.push({ node: ref, way: owner.feature.id, cls: owner.interp.classId, ...best, x: Math.round(node.x), y: Math.round(node.y) });
  }
  gaps.sort((a, b) => a.distance - b.distance);

  // Różne węzły OSM w tym samym miejscu: wyglądają na połączenie, ale w danych nim nie są.
  const coincident = [];
  const nodeCells = new Map();
  for (const [ref, node] of nodes) {
    const key = `${Math.floor(node.x)}:${Math.floor(node.y)}`;
    if (!nodeCells.has(key)) nodeCells.set(key, []);
    nodeCells.get(key).push([ref, node]);
  }
  for (const [ref, node] of nodes) {
    const cx = Math.floor(node.x), cy = Math.floor(node.y);
    for (let i = cx - 1; i <= cx + 1; i += 1) for (let j = cy - 1; j <= cy + 1; j += 1) {
      for (const [other, second] of nodeCells.get(`${i}:${j}`) ?? []) {
        if (other > ref && Math.hypot(node.x - second.x, node.y - second.y) < 0.5) coincident.push({ nodes: [ref, other], ways: [...new Set([...node.uses, ...second.uses].map((u) => u.id))], x: Math.round(node.x), y: Math.round(node.y) });
      }
    }
  }
  const carriageway = (id) => Boolean(model.states.get(id).interp.classDef.carriageway);
  const degree = { dangling: 0, continuation: 0, junction: 0 };
  for (const node of nodes.values()) {
    const ways = new Set(node.uses.map((u) => u.id)).size;
    if (ways === 1 && node.uses.some((u) => u.end)) degree.dangling += 1;
    else if (ways === 2 && node.uses.every((u) => u.end)) degree.continuation += 1;
    else if (ways >= 2) degree.junction += 1;
  }
  const topology = {
    ...degree, endsNearOtherWay: gaps.length, carriagewayPairs: gaps.filter((g) => carriageway(g.way) && carriageway(g.other)).length,
    pathEnds: gaps.filter((g) => !carriageway(g.way)).length, coincidentNodes: coincident.length, levelTagged: lines.filter((s) => s.tagsNow.level !== undefined).length,
    examples: gaps.filter((g) => carriageway(g.way)).slice(0, 6), coincident: coincident.slice(0, 6),
  };

  const separation = [];
  for (const crossing of model.index.crossings) {
    const a = model.states.get(crossing.a), b = model.states.get(crossing.b);
    if (!a || !b || !isTransport(a) || !isTransport(b) || crossing.sharedNode) continue;
    const oa = orderOf(a.interp), ob = orderOf(b.interp);
    if (oa === ob) continue;
    const [up, low] = oa > ob ? [a, b] : [b, a];
    if (!up.level.lifted && !low.level.lifted) continue;
    const gap = zNear(up, crossing.x, crossing.y) - zNear(low, crossing.x, crossing.y);
    separation.push({ upper: up.feature.id, lower: low.feature.id, gap: +gap.toFixed(2), x: Math.round(crossing.x), y: Math.round(crossing.y) });
  }
  separation.sort((a, b) => a.gap - b.gap);

  return {
    transportWays: lines.length, sharedNodes: [...nodes.values()].filter((n) => n.uses.length > 1).length,
    heightJumps: { count: jumps.length, max: jumps[0]?.size ?? 0, top: jumps.slice(0, 12) },
    steepSegments: { count: steep.length, liftedCount: steep.filter((s) => s.lifted).length, top: steep.slice(0, 10) },
    topologyGaps: { count: gaps.length, top: gaps.slice(0, 12) },
    topology,
    separation: { checked: separation.length, belowMinimum: separation.filter((s) => s.gap < minClearance).length, wrongOrder: separation.filter((s) => s.gap <= 0).length, worst: separation.slice(0, 8) },
  };
}
