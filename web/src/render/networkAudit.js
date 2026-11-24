// Audyt tego, co renderer naprawdę generuje na połączeniach sieci. Działa na trójkątach wstęg, nie na założeniach.
import { auditContinuity } from "../core/audit.js";
import { stairPoint } from "../core/steps.js";

const MARK_GROUP = "roadMarkings";
const DECK_ORDER_TOLERANCE = 0.06;
const widthOfPlan = (s) => s.interp.dimensions.width?.value ?? s.interp.classDef.widthMeters ?? 2;
const isNetwork = (s) => s.feature.geometry === "way" && s.interp.geometry === "line" && s.interp.classDef.levelCheck === "transport" && s.level;
const FILL_KINDS = new Set(["ground", "groundOther", "raised", "raisedOther", "sunk"]);

export function collect(features, state) {
  const buckets = new Map();
  const bucket = (kind, def) => {
    const key = `${kind}|${def.tier}`;
    if (!buckets.has(key)) buckets.set(key, { kind, range: 0, index: [], count: 0, a: {}, roles: [], push(name, ...v) { (this.a[name] ??= []).push(...v); } });
    return buckets.get(key);
  };
  features._emit(state, bucket);
  const triangles = [], vertices = [];
  for (const b of buckets.values()) {
    if (!FILL_KINDS.has(b.kind) || !b.a.aMiter) continue;
    const { position: p, aMiter: m, aHalf: h, aSide: side } = b.a;
    const fill = (i) => (b.roles[i] ?? "fill") === "fill";
    const world = (i) => [p[i * 3] + m[i * 2] * h[i], p[i * 3 + 1] + m[i * 2 + 1] * h[i]];
    for (let i = 0; i < h.length; i += 1) if (fill(i)) vertices.push({ cx: p[i * 3], cy: p[i * 3 + 1], side: side[i], half: h[i], at: world(i) });
    for (let i = 0; i < b.index.length; i += 3) if (fill(b.index[i])) triangles.push([...world(b.index[i]), ...world(b.index[i + 1]), ...world(b.index[i + 2])]);
  }
  return { triangles, vertices };
}

function inTriangle(px, py, t) {
  const d1 = (px - t[2]) * (t[1] - t[3]) - (t[0] - t[2]) * (py - t[3]);
  const d2 = (px - t[4]) * (t[3] - t[5]) - (t[2] - t[4]) * (py - t[5]);
  const d3 = (px - t[0]) * (t[5] - t[1]) - (t[4] - t[0]) * (py - t[1]);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function distanceToLine(px, py, points) {
  let best = Infinity;
  for (let i = 3; i < points.length; i += 3) {
    const ax = points[i - 3], ay = points[i - 2], dx = points[i] - ax, dy = points[i + 1] - ay;
    if (Number.isNaN(dx + dy)) continue;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return best;
}

function nearPart(points, x, y, radius) {
  // Zostawia także sąsiada punktu z obszaru, aby długi odcinek nie został ucięty.
  const count = points.length / 3, out = [];
  const near = (i) => i >= 0 && i < count && Math.hypot(points[i * 3] - x, points[i * 3 + 1] - y) < radius + 20;
  let open = false;
  for (let i = 0; i < count; i += 1) {
    if (near(i - 1) || near(i) || near(i + 1)) { out.push(points[i * 3], points[i * 3 + 1], 0); open = true; }
    else if (open) { out.push(NaN, NaN, 0); open = false; } // przerwa: fragmenty nie mogą tworzyć fałszywej cięciwy
  }
  return out;
}

export function geometryAudit(engine) {
  const { model, features } = engine;
  const ways = [...model.states.values()].filter(isNetwork);
  const emitted = new Map(ways.map((s) => [s.feature.id, collect(features, s)]));
  const nodes = new Map();
  for (const s of ways) {
    const { nodeRefs, nodeIndex } = s.feature, points = features.axisOf?.(s) ?? s.feature.points;
    const half = (s.interp.dimensions.width?.value ?? s.interp.classDef.widthMeters ?? 2) / 2;
    nodeRefs.forEach((ref, i) => {
      const k = nodeIndex[i] * 3;
      if (!nodes.has(ref)) nodes.set(ref, { ref, x: points[k], y: points[k + 1], uses: [] });
      nodes.get(ref).uses.push({ s, half, end: i === 0 || i === nodeRefs.length - 1, points, x: points[k], y: points[k + 1] });
    });
  }
  // Pokrycie liczymy względem całej sieci: dalszy ciąg drogi może być osobnym wayem niedochodzącym do tego węzła.
  const CELL = 30, coverGrid = new Map();
  for (const { triangles } of emitted.values()) {
    for (const t of triangles) {
      const x0 = Math.floor(Math.min(t[0], t[2], t[4]) / CELL), x1 = Math.floor(Math.max(t[0], t[2], t[4]) / CELL);
      const y0 = Math.floor(Math.min(t[1], t[3], t[5]) / CELL), y1 = Math.floor(Math.max(t[1], t[3], t[5]) / CELL);
      for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) {
        const key = `${x}:${y}`;
        if (!coverGrid.has(key)) coverGrid.set(key, []);
        coverGrid.get(key).push(t);
      }
    }
  }
  // Rzut biegu schodów jest pokryciem jak nawierzchnia, choć schody nie mają własnej wstęgi.
  for (const plan of model.stairs?.byId.values() ?? []) {
    const { points } = plan, half = plan.width / 2;
    for (let i = 3; i < points.length; i += 3) {
      const ax = points[i - 3], ay = points[i - 2], bx = points[i], by = points[i + 1], l = Math.hypot(bx - ax, by - ay) || 1, nx = (-(by - ay) / l) * half, ny = ((bx - ax) / l) * half;
      for (const t of [[ax + nx, ay + ny, ax - nx, ay - ny, bx - nx, by - ny], [ax + nx, ay + ny, bx - nx, by - ny, bx + nx, by + ny]]) {
        const x0 = Math.floor(Math.min(t[0], t[2], t[4]) / CELL), x1 = Math.floor(Math.max(t[0], t[2], t[4]) / CELL), y0 = Math.floor(Math.min(t[1], t[3], t[5]) / CELL), y1 = Math.floor(Math.max(t[1], t[3], t[5]) / CELL);
        for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) { const key = `${x}:${y}`; if (!coverGrid.has(key)) coverGrid.set(key, []); coverGrid.get(key).push(t); }
      }
    }
  }
  const coveredByNetwork = (x, y) => (coverGrid.get(`${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`) ?? []).some((t) => inTriangle(x, y, t));
  const result = { joints: 0, twoWayEnds: 0, withGap: 0, gapM2: 0, withProtrusion: 0, protrusionM2: 0, continuations: 0, edgeSteps: 0, maxEdgeStep: 0, widthContacts: 0, widthSteps: 0, classContacts: 0 };
  const worst = [], small = [];
  for (const node of nodes.values()) {
    const ids = new Set(node.uses.map((u) => u.s.feature.id));
    if (ids.size < 2) continue;
    result.joints += 1;
    const uses = node.uses;
    const hMax = Math.max(...uses.map((u) => u.half));
    const hMean = uses.reduce((t, u) => t + u.half, 0) / uses.length;
    const reach = hMax * 1.7 + 0.5, step = Math.max(0.3, hMax / 5);
    // Przy przejściu między szerokościami wstęga ma w węźle szerokość pośrednią; wymagane pokrycie jej nie przekracza.
    const drawnHalf = (u) => Math.min(u.half, Math.max(0, ...emitted.get(u.s.feature.id).vertices.filter((v) => Math.abs(v.side) === 1 && Math.hypot(v.cx - u.x, v.cy - u.y) < 0.01).map((v) => v.half)) || u.half);
    // Końce trasy są płaskie albo leżą pod inną trasą, więc za nimi nawierzchnia nie jest wymagana.
    const endsOf = (u) => {
      const p = u.points, n = p.length / 3, unit = (dx, dy) => { const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
      return [[p[0], p[1], ...unit(p[3] - p[0], p[4] - p[1])], [p[(n - 1) * 3], p[(n - 1) * 3 + 1], ...unit(p[(n - 2) * 3] - p[(n - 1) * 3], p[(n - 2) * 3 + 1] - p[(n - 1) * 3 + 1])]];
    };
    const local = uses.map((u) => ({ ...u, drawn: drawnHalf(u), ends: endsOf(u), line: nearPart(u.points, node.x, node.y, reach) }));
    const triangles = [];
    for (const u of uses) {
      for (const t of emitted.get(u.s.feature.id).triangles) {
        if (Math.max(t[0], t[2], t[4]) < node.x - reach || Math.min(t[0], t[2], t[4]) > node.x + reach) continue;
        if (Math.max(t[1], t[3], t[5]) < node.y - reach || Math.min(t[1], t[3], t[5]) > node.y + reach) continue;
        triangles.push(t);
      }
    }
    let gap = 0, extra = 0;
    for (let px = node.x - reach; px <= node.x + reach; px += step) {
      for (let py = node.y - reach; py <= node.y + reach; py += step) {
        let required = false, allowed = false;
        for (const u of local) {
          const d = distanceToLine(px, py, u.line);
          // Schody są bryłą zaczynającą się na krawędzi dojścia; ich styk sprawdza auditStairs.
          const behindEnd = u.ends.some(([ex, ey, ix, iy]) => Math.hypot(px - ex, py - ey) <= u.half * 1.5 && (px - ex) * ix + (py - ey) * iy < 0);
          if (!u.s.interp.classDef.stairs && !behindEnd && d <= 0.85 * Math.min(u.drawn, hMean)) required = true;
          if (d <= Math.max(u.half, hMean) * 1.18 + 0.2) allowed = true;
        }
        if (!required && allowed) continue;
        if (required && !coveredByNetwork(px, py)) gap += 1;
        if (!allowed && triangles.some((t) => inTriangle(px, py, t))) extra += 1;
      }
    }
    const cell = step * step, gapArea = gap * cell, extraArea = extra * cell;
    if (gapArea > 0.1) { result.withGap += 1; result.gapM2 += gapArea; }
    if (extraArea > 0.1) { result.withProtrusion += 1; result.protrusionM2 += extraArea; }
    if (gapArea > 0.1 || extraArea > 0.1) small.push({ node: node.ref, x: Math.round(node.x), y: Math.round(node.y), gapM2: +gapArea.toFixed(2), protrusionM2: +extraArea.toFixed(2), ways: uses.map((u) => `${u.s.feature.id}:${u.s.interp.classId}:${u.half}:${u.end ? "koniec" : "środek"}`) });

    const classes = new Set(uses.map((u) => u.s.interp.classId));
    if (classes.size > 1) result.classContacts += 1;
    let edgeStep = 0;
    const twoEnds = ids.size === 2 && uses.length === 2 && uses.every((u) => u.end);
    if (twoEnds) result.twoWayEnds += 1;
    // Para końców wybrana przez renderer ma tworzyć jedną wstęgę; ostry zakręt pozostaje węzłem z zaokrągleniem.
    const entries = features._jointMap?.().get(node.ref)?.filter((e) => e.partner && e.state.interp.classDef.levelCheck === "transport" && e.partner.state.interp.classDef.levelCheck === "transport") ?? [];
    const pair = entries.length ? uses.filter((u) => u.s === entries[0].state || u.s === entries[0].partner.state) : uses;
    const smooth = features._jointMap ? entries.length >= 2 && pair.length === 2 : twoEnds;
    // Rozwidlenie: krawędzie pnia przechodzą w zewnętrzne krawędzie skrajnych gałęzi, które leżą obok siebie.
    const forkTrunk = uses.find((u) => {
      const plan = features.model?.surfaces?.byId.get(u.s.feature.id), refs = u.s.feature.nodeRefs;
      return u.end && plan?.forkTotal?.[refs[0] === node.ref ? "start" : refs[refs.length - 1] === node.ref ? "end" : ""];
    });
    if (forkTrunk) {
      result.forks = (result.forks ?? 0) + 1;
      const rowsOf = (u) => emitted.get(u.s.feature.id).vertices.filter((v) => Math.hypot(v.cx - u.x, v.cy - u.y) < 0.5 && Math.abs(v.side) === 1);
      const trunkRows = rowsOf(forkTrunk), branchRows = uses.filter((u) => u.s !== forkTrunk.s).flatMap(rowsOf);
      if (trunkRows.length && branchRows.length) {
        edgeStep = Math.max(...trunkRows.map((v) => Math.min(...branchRows.map((w) => Math.hypot(v.at[0] - w.at[0], v.at[1] - w.at[1])))));
        result.maxForkStep = Math.max(result.maxForkStep ?? 0, edgeStep);
        if (edgeStep > 0.1) result.forkSteps = (result.forkSteps ?? 0) + 1;
      }
    } else if (smooth) {
      result.continuations += 1;
      const rows = pair.map((u) => emitted.get(u.s.feature.id).vertices.filter((v) => Math.hypot(v.cx - u.x, v.cy - u.y) < 0.01 && Math.abs(v.side) === 1));
      const halves = rows.map((r) => r.map((v) => v.half));
      if (Math.abs(pair[0].half - pair[1].half) > 0.05) {
        result.widthContacts += 1;
        if (halves[0].length && halves[1].length && Math.abs(Math.max(...halves[0]) - Math.max(...halves[1])) > 0.05) result.widthSteps += 1;
      }
      if (rows[0].length && rows[1].length) {
        // Dla każdej krawędzi jednej wstęgi szukamy najbliższej krawędzi drugiej; zakończenia tworzą dodatkowe pary.
        edgeStep = Math.max(...[0, 1].map((a) => Math.max(...rows[a].map((v) => Math.min(...rows[1 - a].map((w) => Math.hypot(v.at[0] - w.at[0], v.at[1] - w.at[1])))))));
        result.maxEdgeStep = Math.max(result.maxEdgeStep, edgeStep);
        if (edgeStep > 0.1) result.edgeSteps += 1;
      }
    }
    const score = gapArea + extraArea + edgeStep;
    if (score > 0.5) worst.push({ node: node.ref, x: Math.round(node.x), y: Math.round(node.y), gapM2: +gapArea.toFixed(1), protrusionM2: +extraArea.toFixed(1), edgeStep: +edgeStep.toFixed(2), classes: [...classes].join("+"), ways: [...ids].length, score });
  }
  worst.sort((a, b) => b.score - a.score);
  result.gapM2 = +result.gapM2.toFixed(1); result.protrusionM2 = +result.protrusionM2.toFixed(1); result.maxEdgeStep = +result.maxEdgeStep.toFixed(2);
  small.sort((a, b) => b.gapM2 + b.protrusionM2 - a.gapM2 - a.protrusionM2);
  return { ...result, worst: worst.slice(0, 10).map(({ score, ...w }) => w), defects: small.slice(0, 12) };
}

/** Czy połączone trasy są jednocześnie rysowane przy węźle, dla kamery ustawionej w podanych miejscach. */
function lodAudit(engine, cameras) {
  const { model, features, rig } = engine;
  const saved = { x: rig.target.x, y: rig.target.y, z: rig.target.z, d: rig.distance, t: rig.tilt, a: rig.azimuth };
  const owner = new Map();
  for (const chunk of features.chunks.values()) for (const id of chunk.ids) owner.set(id, chunk);
  const drawnAt = (s, x, y, z) => {
    const def = s.interp.classDef;
    if (!owner.get(s.feature.id)?.meshes.some((m) => m.visible && m.userData.tier === def.tier && m.userData.group === def.group)) return false;
    return features.drawnAtDistance ? features.drawnAtDistance(def.tier, Math.hypot(x - engine.camera.position.x, y - engine.camera.position.y, z - engine.camera.position.z)) : true;
  };
  const nodes = new Map();
  for (const s of model.states.values()) {
    if (!isNetwork(s)) continue;
    const { nodeRefs, nodeIndex, points } = s.feature;
    nodeRefs.forEach((ref, i) => {
      if (!nodes.has(ref)) nodes.set(ref, []);
      nodes.get(ref).push({ s, x: points[nodeIndex[i] * 3], y: points[nodeIndex[i] * 3 + 1], z: s.level.z[nodeIndex[i]] });
    });
  }
  const perCamera = [];
  for (const c of cameras) {
    rig.target.set(c.x, c.y, 90); rig.distance = c.d; rig.tilt = c.t; rig.azimuth = c.a; rig.apply();
    features.updateLod(engine.camera.position);
    let broken = 0, checked = 0;
    for (const uses of nodes.values()) {
      const sameTier = uses.filter((u, i) => uses.findIndex((v) => v.s === u.s) === i);
      if (sameTier.length < 2 || new Set(sameTier.map((u) => u.s.interp.classDef.tier)).size !== 1) continue;
      checked += 1;
      const seen = sameTier.map((u) => drawnAt(u.s, u.x, u.y, u.z));
      if (seen.some(Boolean) && !seen.every(Boolean)) broken += 1;
    }
    perCamera.push({ ...c, checked, broken });
  }
  rig.target.set(saved.x, saved.y, saved.z); rig.distance = saved.d; rig.tilt = saved.t; rig.azimuth = saved.a; rig.apply();
  features.updateLod(engine.camera.position);
  return perCamera;
}

function terrainAudit(engine) {
  const terrain = engine.terrain;
  const visible = [...terrain.tiles.values()].filter((t) => t.mesh?.visible && t.heights);
  const surface = (t, x, y) => {
    const b = terrain.bounds(t.z, t.x, t.y), s = b.size / terrain.cells, n = terrain.size;
    const u = (x - b.west) / s, v = (y - b.south) / s;
    if (u < -1e-6 || v < -1e-6 || u > terrain.cells + 1e-6 || v > terrain.cells + 1e-6) return null;
    const i = Math.min(terrain.cells - 1, Math.floor(u)), j = Math.min(terrain.cells - 1, Math.floor(v)), fu = u - i, fv = v - j, h = t.heights;
    return h[j * n + i] * (1 - fu) * (1 - fv) + h[j * n + i + 1] * fu * (1 - fv) + h[(j + 1) * n + i] * (1 - fu) * fv + h[(j + 1) * n + i + 1] * fu * fv;
  };
  const diffs = { same: [], cross: [] };
  for (const a of visible) {
    const b = terrain.bounds(a.z, a.x, a.y), s = b.size / terrain.cells;
    for (let k = 0; k <= terrain.cells; k += 4) {
      for (const [x, y] of [[b.west + b.size, b.south + k * s], [b.west + k * s, b.south + b.size]]) {
        const ha = surface(a, x, y);
        if (!Number.isFinite(ha)) continue;
        for (const o of visible) {
          if (o === a) continue;
          const obounds = terrain.bounds(o.z, o.x, o.y);
          if (x < obounds.west || x > obounds.west + obounds.size || y < obounds.south || y > obounds.south + obounds.size) continue;
          const hb = surface(o, x, y);
          if (Number.isFinite(hb)) diffs[o.z === a.z ? "same" : "cross"].push(Math.abs(ha - hb));
        }
      }
    }
  }
  const stat = (list) => { if (!list.length) return { samples: 0 }; list.sort((p, q) => p - q); return { samples: list.length, median: +list[list.length >> 1].toFixed(2), p99: +list[Math.floor(list.length * 0.99)].toFixed(2), max: +list[list.length - 1].toFixed(2), overSkirt: list.filter((v) => v > 25).length }; };
  return { visibleTiles: visible.length, sameLevelEdges: stat(diffs.same), crossLevelEdges: stat(diffs.cross) };
}

const isElevated = (s) => isNetwork(s) && !s.interp.classDef.stairs && ((s.level.lifted && s.level.units > 0) || s.level.maxOffset > 0.4);

/** Nawierzchnie, linie i oznakowanie: pochodzenie z tagów oraz piksele przy włączonych i wyłączonych warstwach. */
export function auditSurfacing(engine, { samples = 18 } = {}) {
  const { model, features, rig, renderer, camera, scene, shared } = engine;
  const toBytes = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const near = (a, b, tolerance) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tolerance;
  const out = { ...model.surfaces.stats, markingsWithoutTags: 0, arrowsWithoutTurnTags: 0, dashesOnCrossings: 0, arrowsOnCrossings: 0, classes: {}, markings: { checked: 0, visible: 0, hiddenWhenOff: 0 }, crossingMarks: { checked: 0, visible: 0, covered: 0 }, failures: [] };
  const reachOf = (plan) => model.profile.surfaces.arrowHalfLengthMeters * Math.min(1, (plan.laneWidth ?? model.profile.surfaces.laneWidthMeters) / model.profile.surfaces.laneWidthMeters);
  for (const plan of model.surfaces.byId.values()) {
    const tags = model.states.get(plan.id).tagsNow;
    if (plan.dividers.length && (!tags.lanes || tags.lane_markings === "no")) out.markingsWithoutTags += 1;
    if (plan.arrows.length && !Object.keys(tags).some((k) => k.startsWith("turn:lanes"))) out.arrowsWithoutTurnTags += 1;
    for (const [a, b] of plan.coreZones) {
      for (const divider of plan.dividers) out.dashesOnCrossings += divider.dashes.filter(([from, to]) => to > a && from < b).length;
      out.arrowsOnCrossings += plan.arrows.filter((arrow) => arrow.s + reachOf(plan) > a && arrow.s - reachOf(plan) < b).length;
    }
  }
  const saved = { x: rig.target.x, y: rig.target.y, z: rig.target.z, d: rig.distance, t: rig.tilt, a: rig.azimuth }, markers = engine.markers.visible, hidden = new Set(features.hiddenGroups);
  engine.markers.visible = false;
  const canvas = renderer.domElement, pixel = new Uint8Array(4);
  const look = (x, y, z, tx, ty, d) => { rig.target.set(x, y, z); rig.distance = d; rig.tilt = 0; rig.azimuth = Math.atan2(tx, ty); rig.apply(); features.updateLod(camera.position); };
  const read = (x, y, z, pick = false) => {
    const v = camera.position.clone().set(x, y, z).project(camera);
    camera.setViewOffset(canvas.width, canvas.height, Math.floor(((v.x + 1) / 2) * canvas.width), Math.floor(((1 - v.y) / 2) * canvas.height), 1, 1);
    shared.uPick.value = pick ? 1 : 0;
    renderer.setRenderTarget(engine.pickTarget); renderer.clear(); renderer.render(scene, camera);
    renderer.readRenderTargetPixels(engine.pickTarget, 0, 0, 1, 1, pixel);
    renderer.setRenderTarget(null); camera.clearViewOffset(); shared.uPick.value = 0;
    return pick ? features.featureFromPick(pixel[0] | (pixel[1] << 8) | (pixel[2] << 16)) : [...pixel.slice(0, 3)];
  };
  const frameOf = (plan, state, ratio = 0.5) => {
    const s = plan.length * ratio, f = features._axisFrame(plan, state.level.z, s), g = features._axisFrame({ ...plan, axis: state.feature.points }, state.level.z, s);
    return { f, g };
  };
  for (const [name, test] of [["drogi", (d) => d.carriageway], ["rowery", (d) => d.routeLine === "routeLinesCycle"], ["piesi", (d) => d.routeLine === "routeLinesFoot" && !d.stairs]]) {
    const pool = [...model.surfaces.byId.values()].filter((p) => { const s = model.states.get(p.id); return p.line && p.length > 25 && !p.centerOffset && !s.level?.lifted && test(s.interp.classDef) && !p.provenance.surface.approximate && !p.dividers.length && !p.arrows.length; });
    const row = out.classes[name] = { checked: 0, lineVisible: 0, lineOffShowsMaterial: 0, materialBeside: 0, covered: 0 }, step = Math.max(1, Math.floor(pool.length / samples));
    for (let i = 0; i < pool.length; i += step) {
      const plan = pool[i], state = model.states.get(plan.id), { g } = frameOf(plan, state), material = [toBytes(plan.material.color), toBytes(plan.material.accent)], line = toBytes(plan.line.color);
      look(g.x, g.y, g.z, g.tx, g.ty, 14);
      // Próbka leży przy krawędzi linii: środek może zajmować kolor relacji trasy.
      const offset = Math.max(plan.line.half * 1.6, (widthOfPlan(state) / 2) * 0.68), inLine = plan.line.half * 0.72, lx = g.x + g.rx * inLine, ly = g.y + g.ry * inLine, bx = g.x + g.rx * offset, by = g.y + g.ry * offset;
      // Sąsiednia trasa może leżeć na tym samym miejscu; wtedy próbka nie opisuje badanego obiektu.
      if (read(lx, ly, g.z + 0.05, true) !== plan.id || read(bx, by, g.z, true) !== plan.id) { row.covered += 1; continue; }
      row.checked += 1;
      // Faktura miesza kolor bazowy z akcentem, więc poprawny piksel leży między nimi.
      const isMaterial = (c) => { const [a, b] = material, d = [0, 1, 2].map((k) => b[k] - a[k]), t = Math.max(0, Math.min(1, d.reduce((s, v, k) => s + v * (c[k] - a[k]), 0) / (d.reduce((s, v) => s + v * v, 0) || 1))); return near(c, a.map((v, k) => v + d[k] * t), 20); };
      const seen = read(lx, ly, g.z + 0.05), beside = read(bx, by, g.z);
      const lineOk = near(seen, line, 24), besideOk = isMaterial(beside);
      if (lineOk) row.lineVisible += 1;
      if (besideOk) row.materialBeside += 1;
      features.hiddenGroups.add(plan.line.group); features.updateLod(camera.position);
      const off = read(lx, ly, g.z + 0.05), offOk = isMaterial(off);
      if (offOk) row.lineOffShowsMaterial += 1;
      features.hiddenGroups.delete(plan.line.group); features.updateLod(camera.position);
      if (!lineOk || !besideOk || !offOk) out.failures.push({ type: name, id: plan.id, material: plan.materialId, seen, beside, off, expectedLine: plan.line.color, expected: plan.material.color });
    }
  }
  const cfg = model.profile.surfaces;
  // Linie przebiegu są schematem na wierzchu i celowo przykrywają malowanie; malowanie sprawdzamy przy wyłączonym schemacie.
  for (const group of new Set(Object.values(model.profile.classes).map((c) => c.routeLine).filter(Boolean))) features.hiddenGroups.add(group);
  features.updateLod(camera.position);
  for (const plan of [...model.surfaces.byId.values()].filter((p) => p.crossing?.spans.length)) {
    const state = model.states.get(plan.id), part = plan.crossing.parts.find((q) => q.spans?.length), [from, to, compact] = part.spans[0], colour = toBytes(part.approximate ? cfg.assumedMarkingColor : cfg.markingColor);
    const period = compact ? cfg.crossingCompactPeriodMeters : cfg.crossingPeriodMeters;
    const s = part.pattern === "zebra" ? from + period / 2 + Math.floor((to - from) / 2 / period) * period : part.pattern === "blocks" ? from + cfg.crossingBlockMeters / 2 : (from + to) / 2;
    const a = features._axisFrame(plan, state.level.z, from), c = features._axisFrame(plan, state.level.z, to), chord = Math.hypot(c.x - a.x, c.y - a.y) || 1, k = (s - from) / (to - from || 1);
    const f = { x: a.x + (c.x - a.x) * k, y: a.y + (c.y - a.y) * k, z: features._axisFrame(plan, state.level.z, s).z, tx: (c.x - a.x) / chord, ty: (c.y - a.y) / chord, rx: (c.y - a.y) / chord, ry: -(c.x - a.x) / chord }, lateral = part.offset + (part.pattern === "zebra" ? (compact ? plan.crossing.compactHalf : part.half) * 0.5 : part.pattern === "blocks" ? part.half - cfg.crossingBlockMeters / 2 : part.half), x = f.x + f.rx * lateral, y = f.y + f.ry * lateral;
    look(x, y, f.z, f.tx, f.ty, 6);
    const top = read(x, y, f.z + 0.05, true);
    if (top !== plan.id) { out.crossingMarks.covered += 1; (out.crossingMarks.coveredBy ??= []).push({ id: plan.id, by: top ?? "teren", at: [Math.round(x), Math.round(y)] }); continue; }
    out.crossingMarks.checked += 1;
    const seen = read(x, y, f.z + 0.05);
    if (near(seen, colour, 26)) out.crossingMarks.visible += 1; else out.failures.push({ type: part.pattern, id: plan.id, seen });
  }
  const lanes = [...model.surfaces.byId.values()].filter((p) => p.dividers.some((d) => d.dashes.length) && !p.centerOffset && !p.transition && p.length > 40 && !model.states.get(p.id).level?.lifted);
  const step = Math.max(1, Math.floor(lanes.length / samples));
  for (let i = 0; i < lanes.length; i += step) {
    const plan = lanes[i], state = model.states.get(plan.id), dashes = plan.dividers[0].dashes, dash = dashes[Math.floor(dashes.length / 2)];
    if (!dash) continue;
    const s = (dash[0] + dash[1]) / 2;
    const f = features._axisFrame(plan, state.level.z, s), o = plan.dividers[0].offset, x = f.x + f.rx * o, y = f.y + f.ry * o, colour = toBytes(plan.dividers[0].confirmed ? cfg.markingColor : cfg.assumedMarkingColor);
    look(x, y, f.z, f.tx, f.ty, 6);
    if (read(x, y, f.z + 0.03, true) !== plan.id) continue;
    out.markings.checked += 1;
    const seen = read(x, y, f.z + 0.03), visible = near(seen, colour, 26);
    if (visible) out.markings.visible += 1;
    features.hiddenGroups.add(MARK_GROUP); features.updateLod(camera.position);
    if (!near(read(x, y, f.z + 0.03), colour, 26)) out.markings.hiddenWhenOff += 1;
    features.hiddenGroups.delete(MARK_GROUP); features.updateLod(camera.position);
    if (!visible) out.failures.push({ type: "pas", id: plan.id, seen, expected: plan.dividers[0].confirmed ? cfg.markingColor : cfg.assumedMarkingColor, lanes: plan.lanes, offset: o });
  }
  engine.markers.visible = markers; features.hiddenGroups = hidden;
  rig.target.set(saved.x, saved.y, saved.z); rig.distance = saved.d; rig.tilt = saved.t; rig.azimuth = saved.a; rig.apply();
  features.updateLod(camera.position); engine.invalidate();
  return out;
}

/** Tunele: ciągłość tuby, otwarte wloty i ukrycie wnętrza pod terenem, sprawdzane na pikselach. */
export async function auditTunnels(engine) {
  const { model, features, rig, renderer, camera, scene, shared } = engine, plans = [...model.tunnels.byId.values()];
  const out = { ...model.tunnels.stats, cutsInShader: shared.uCutCount.value, cutOverflow: engine.cutOverflow ?? 0, roofThroughRoute: 0, portalsChecked: 0, portalsOpen: 0, portalsBlocked: [], hiddenChecked: 0, hiddenUnderGround: 0, exposedRoof: 0, seenThroughTerrain: [] };
  // Strop nie może wystawać ponad trasę przechodzącą nad tunelem.
  for (const plan of plans) {
    const state = model.states.get(plan.id);
    for (const other of model.states.values()) {
      if (other === state || other.feature.geometry !== "way" || other.interp.geometry !== "line" || !other.level?.z || other.interp.classDef.levelCheck !== "transport" || model.tunnels.byId.has(other.feature.id)) continue;
      const p = other.feature.points, zz = other.level.z;
      for (let i = 0; i < p.length / 3; i += 1) {
        for (const c of plan.cuts) {
          const dx = c.bx - c.ax, dy = c.by - c.ay, t = ((p[i * 3] - c.ax) * dx + (p[i * 3 + 1] - c.ay) * dy) / (dx * dx + dy * dy || 1);
          if (t < 0 || t > 1 || Math.hypot(p[i * 3] - c.ax - dx * t, p[i * 3 + 1] - c.ay - dy * t) > c.half) continue;
          const base = c.za + (c.zb - c.za) * t;
          // Trasa dochodząca do wlotu leży na posadzce; liczy się tylko trasa wyraźnie nad nią, a pod górą stropu.
          if (zz[i] > base + c.top - c.top * 0.5 && zz[i] < base + c.top - 0.05) { out.roofThroughRoute += 1; break; }
        }
      }
    }
  }
  const saved = { x: rig.target.x, y: rig.target.y, z: rig.target.z, d: rig.distance, t: rig.tilt, a: rig.azimuth }, markers = engine.markers.visible;
  engine.markers.visible = false;
  // Linie przebiegu są schematem rysowanym na wierzchu, także nad tunelem; sprawdzamy bryłę przy wyłączonym schemacie.
  const hiddenBefore = new Set(features.hiddenGroups);
  for (const group of new Set(Object.values(model.profile.classes).map((c) => c.routeLine).filter(Boolean))) features.hiddenGroups.add(group);
  const canvas = renderer.domElement, pixel = new Uint8Array(4);
  const read = (x, y, z) => {
    const v = camera.position.clone().set(x, y, z).project(camera);
    camera.setViewOffset(canvas.width, canvas.height, Math.floor(((v.x + 1) / 2) * canvas.width), Math.floor(((1 - v.y) / 2) * canvas.height), 1, 1);
    shared.uPick.value = 1;
    renderer.setRenderTarget(engine.pickTarget); renderer.clear(); renderer.render(scene, camera);
    renderer.readRenderTargetPixels(engine.pickTarget, 0, 0, 1, 1, pixel);
    renderer.setRenderTarget(null); camera.clearViewOffset(); shared.uPick.value = 0;
    return features.featureFromPick(pixel[0] | (pixel[1] << 8) | (pixel[2] << 16));
  };
  // Kafle terenu doczytują się po ruchu kamery; odczyt z grubszymi kaflami nie odpowiadałby obrazowi.
  const settle = async () => {
    features.updateLod(camera.position); engine.invalidate();
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 300));
    while (performance.now() - started < 6000 && !engine.terrain.settled) { engine.invalidate(); await new Promise((resolve) => setTimeout(resolve, 120)); }
  };
  // Kamera w punkcie eye patrzy na punkt target.
  const aim = async (eye, target) => {
    const dx = target.x - eye.x, dy = target.y - eye.y, dz = eye.z - target.z, distance = Math.hypot(dx, dy, dz);
    rig.target.set(target.x, target.y, target.z); rig.distance = distance; rig.azimuth = Math.atan2(dx, dy); rig.tilt = Math.acos(Math.max(-1, Math.min(1, dz / distance))); rig.apply();
    await settle();
  };
  for (const plan of plans) {
    const { rows } = plan, view = features.tunnelViews?.get(plan.id);
    out.coveredMeters = (out.coveredMeters ?? 0) + (view?.covered ?? 0); out.openMeters = (out.openMeters ?? 0) + (view?.open ?? 0);
    // Wlot: kamera przed portalem patrzy w oś tunelu na punkt 2 m wewnątrz; ma widzieć wnętrze tej tuby.
    for (const portal of view?.portals ?? []) {
      out.portalsChecked += 1;
      // Oko stoi w osi 6 m przed portalem, a cel leży na ścianie wnętrza 3 m za nim: patrząc w samą oś, wzrok przechodziłby przez cały tunel.
      const height = Math.min(1, plan.clearance * 0.4), side = plan.width / 2 - 0.05;
      const target = { x: portal.x - portal.dx * 3 - portal.dy * side, y: portal.y - portal.dy * 3 + portal.dx * side, z: portal.z + height };
      await aim({ x: portal.x + portal.dx * 6, y: portal.y + portal.dy * 6, z: portal.z + height + 0.2 }, target);
      const seen = read(target.x, target.y, target.z);
      if (seen === plan.id) out.portalsOpen += 1; else out.portalsBlocked.push({ id: plan.id, seen: seen ?? "teren", at: [Math.round(portal.x), Math.round(portal.y)] });
    }
    // Środek tunelu z góry: gdy teren leży nad stropem, wnętrza nie widać.
    const mid = view?.inside ?? rows[Math.floor(rows.length / 2)], ground = features.groundAt?.(mid.x, mid.y);
    if (Number.isFinite(ground) && rows.length > 1) {
      const covered = Boolean(view?.inside) && !features._underBuilding(mid.x, mid.y);
      rig.target.set(mid.x, mid.y, mid.z); rig.distance = 60; rig.tilt = 0.2; rig.azimuth = 0; rig.apply();
      await settle();
      const seen = read(mid.x, mid.y, mid.z);
      if (covered) { out.hiddenChecked += 1; if (seen !== plan.id) out.hiddenUnderGround += 1; else out.seenThroughTerrain.push(plan.id); }
      else if (seen === plan.id) out.exposedRoof += 1;
    }
  }
  engine.markers.visible = markers;
  features.hiddenGroups = hiddenBefore;
  rig.target.set(saved.x, saved.y, saved.z); rig.distance = saved.d; rig.tilt = saved.t; rig.azimuth = saved.a; rig.apply();
  features.updateLod(camera.position); engine.invalidate();
  return out;
}

/** Bariery: pochodzenie wymiarów, ciągłość podstawy, styk z terenem oraz otwory w miejscach przejść. */
export function auditBarriers(engine) {
  const { model, features } = engine, out = { ...model.barriers.stats, withoutHeight: 0, spans: 0, maxBaseStep: 0, maxBaseGrade: 0, maxGroundGap: 0, maxExtraHeight: 0, maxKink: 0, maxBetweenGap: 0, buriedBetween: 0, floating: 0, wallsInOpenings: 0 };
  for (const plan of model.barriers.byId.values()) {
    if (!(plan.height >= 0)) out.withoutHeight += 1;
    if (plan.kind !== "way") continue;
    for (const rows of features.barrierProfile(model.states.get(plan.id), plan)) {
      out.spans += 1;
      rows.forEach((row, i) => {
        if (row.bottom > row.ground + 1e-6) out.floating += 1;
        if (plan.passages.some((p) => Math.abs(row.s - p.s) < p.width / 2 - 0.01)) out.wallsInOpenings += 1;
        if (i) { const step = Math.abs(row.base - rows[i - 1].base), run = row.s - rows[i - 1].s; out.maxBaseStep = Math.max(out.maxBaseStep, step); if (run > 0.5) out.maxBaseGrade = Math.max(out.maxBaseGrade, step / run); }
        out.maxGroundGap = Math.max(out.maxGroundGap, Math.abs(row.base - row.ground)); out.maxExtraHeight = Math.max(out.maxExtraHeight, row.base - row.bottom - 0.1);
        if (i > 1) { const a = rows[i - 2], b = rows[i - 1]; if (b.s - a.s > 0.5 && row.s - b.s > 0.5) out.maxKink = Math.max(out.maxKink, Math.abs((row.base - b.base) / (row.s - b.s) - (b.base - a.base) / (b.s - a.s))); }
        if (i && !plan.onStructure && !plan.over?.length) {
          // Kontrola między wierzchołkami siatki: dół bariery nie może wisieć nad terenem, a góra chować się w nim
          // (ściana oporowa kończy się na terenie po wyższej stronie, więc jej góra nie może tylko leżeć niżej niż teren w osi;
          // pod mostem kończy się na spodzie płyty, a teren w osi leży w bryle płyty).
          const a = rows[i - 1], x = (a.x + row.x) / 2, y = (a.y + row.y) / 2, ground = features.groundAt?.(x, y);
          if (Number.isFinite(ground)) { const bottom = (a.bottom + row.bottom) / 2, top = ((a.top ?? a.base + plan.height) + (row.top ?? row.base + plan.height)) / 2; out.maxBetweenGap = Math.max(out.maxBetweenGap, bottom - ground); if (plan.retaining ? !a.underPlate && !row.underPlate && top < ground - 0.3 : top < ground + plan.height * 0.5) out.buriedBetween += 1; }
        }
      });
    }
  }
  for (const key of ["maxBaseStep", "maxBaseGrade", "maxGroundGap", "maxExtraHeight", "maxKink", "maxBetweenGap"]) out[key] = +out[key].toFixed(2);
  return out;
}

/** Kontrola schodów: styk z węzłami, układ stopni oraz rzeczywiste piksele materiału i różowej linii. */
export function auditStairs(engine, { samples = 24 } = {}) {
  const { model, features, rig, renderer, camera, scene, shared } = engine;
  const plans = [...model.stairs.byId.values()];
  const out = { ...model.stairs.stats, endContactOff: 0, nonMonotonic: 0, lineOverTreadViolations: 0, overlaySeparate: 0, pixels: { checked: 0, lineVisible: 0, lineCovered: 0, materialBeside: 0, lineMissing: 0, materialTinted: 0, covered: 0 }, failures: [] };
  const toBytes = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (const plan of plans) {
    const state = model.states.get(plan.id), z = state.level.z;
    const low = Math.min(z[0], z[z.length - 1]), high = Math.max(z[0], z[z.length - 1]);
    const treads = plan.segments.filter((s) => s.kind === "tread");
    if (Math.abs(treads[0].bottom - low) > 0.01 || Math.abs(treads[treads.length - 1].z - high) > 0.01) out.endContactOff += 1;
    if (plan.segments.some((s, i) => i && (s.z < plan.segments[i - 1].z - 1e-6 || s.from < plan.segments[i - 1].to - 1e-6))) out.nonMonotonic += 1;
    const buckets = new Map();
    features._emit(state, (kind, def) => { const key = `${kind}|${def.tier}`; if (!buckets.has(key)) buckets.set(key, { kind, range: 0, index: [], count: 0, a: {}, roles: [], push(n, ...v) { (this.a[n] ??= []).push(...v); } }); return buckets.get(key); });
    // Linia i jej zaokrąglenia muszą mieścić się w wysokości biegu.
    for (const b of buckets.values()) {
      if (b.kind !== "stairLine") continue;
      for (let i = 2; i < b.a.position.length; i += 3) if (b.a.position[i] < low - 0.2 || b.a.position[i] > high + 0.2) { out.lineOverTreadViolations += 1; break; }
    }
    if ([...buckets.values()].some((b) => b.kind === "stairLine" && b.count) && [...buckets.values()].some((b) => b.kind === "stairs" && b.count)) out.overlaySeparate += 1;
  }
  const usable = plans.filter((p) => !p.flat && p.length > 3);
  const stride = Math.max(1, Math.floor(usable.length / samples));
  const saved = { x: rig.target.x, y: rig.target.y, z: rig.target.z, d: rig.distance, t: rig.tilt, a: rig.azimuth }, markers = engine.markers.visible;
  engine.markers.visible = false;
  const canvas = renderer.domElement, pixel = new Uint8Array(4);
  for (let i = 0; i < usable.length; i += stride) {
    const plan = usable[i], mid = plan.segments[Math.floor(plan.segments.length / 2)], d = (mid.from + mid.to) / 2, p = stairPoint(plan, plan.toWay(d));
    rig.target.set(p.x, p.y, mid.z); rig.distance = Math.max(7, plan.width * 4); rig.tilt = 0.45; rig.azimuth = Math.atan2(p.tx, p.ty) + 0.6; rig.apply();
    features.updateLod(camera.position);
    const read = (x, y, z) => {
      const v = camera.position.clone().set(x, y, z).project(camera), px = Math.floor(((v.x + 1) / 2) * canvas.width), py = Math.floor(((1 - v.y) / 2) * canvas.height);
      camera.setViewOffset(canvas.width, canvas.height, px, py, 1, 1);
      renderer.setRenderTarget(engine.pickTarget); renderer.clear(); renderer.render(scene, camera);
      renderer.readRenderTargetPixels(engine.pickTarget, 0, 0, 1, 1, pixel);
      renderer.setRenderTarget(null); camera.clearViewOffset();
      return [...pixel.slice(0, 3)];
    };
    const near = (a, b, tolerance) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tolerance;
    const overlay = toBytes(plan.overlay.color), material = toBytes(plan.material.color), accent = toBytes(plan.material.accent);
    const lineZ = mid.z + 0.03;
    const centre = read(p.x, p.y, lineZ), side = plan.width * 0.32, beside = read(p.x - p.ty * side, p.y + p.tx * side, mid.z);
    out.pixels.checked += 1;
    if (near(centre, overlay, 26)) out.pixels.lineVisible += 1;
    else {
      // Schody pod estakadą lub budynkiem są zasłonięte przez inny obiekt, co nie jest błędem linii.
      const v = camera.position.clone().set(p.x, p.y, lineZ).project(camera);
      camera.setViewOffset(canvas.width, canvas.height, Math.floor(((v.x + 1) / 2) * canvas.width), Math.floor(((1 - v.y) / 2) * canvas.height), 1, 1);
      shared.uPick.value = 1; renderer.setRenderTarget(engine.pickTarget); renderer.clear(); renderer.render(scene, camera);
      renderer.readRenderTargetPixels(engine.pickTarget, 0, 0, 1, 1, pixel); renderer.setRenderTarget(null); camera.clearViewOffset(); shared.uPick.value = 0;
      const seen = features.featureFromPick(pixel[0] | (pixel[1] << 8) | (pixel[2] << 16));
      if (seen === plan.id) { out.pixels.lineMissing += 1; out.failures.push({ id: plan.id, part: "linia", rgb: centre }); } else out.pixels.lineCovered += 1;
    }
    const pink = (c) => c[0] - c[1] > 40 && c[0] - c[2] > 15;
    if (pink(beside)) { out.pixels.materialTinted += 1; out.failures.push({ id: plan.id, part: "materiał", rgb: beside }); }
    else if (Math.min(Math.hypot(...beside.map((v, k) => v - material[k])), Math.hypot(...beside.map((v, k) => v - accent[k]))) < 70) out.pixels.materialBeside += 1;
    else out.pixels.covered += 1;
  }
  engine.markers.visible = markers;
  rig.target.set(saved.x, saved.y, saved.z); rig.distance = saved.d; rig.tilt = saved.t; rig.azimuth = saved.a; rig.apply();
  features.updateLod(camera.position); engine.invalidate();
  out.failures = out.failures.slice(0, 8);
  return out;
}

/** Geometria przekroju: górna płyta, jej krawędź obwódki i górne krawędzie ścian w trzech wymiarach. */
export function sectionGeometry(features, state) {
  const buckets = new Map();
  const bucket = (kind, def) => {
    const key = `${kind}|${def.tier}`;
    if (!buckets.has(key)) buckets.set(key, { kind, range: 0, index: [], count: 0, a: {}, roles: [], push(name, ...v) { (this.a[name] ??= []).push(...v); } });
    return buckets.get(key);
  };
  features._emit(state, bucket);
  const top = [], edges = [], walls = [];
  let degenerate = 0, wrongNormals = 0, wallFaces = 0;
  for (const b of buckets.values()) {
    const p = b.a.position;
    if (b.a.aMiter) {
      const { aMiter: m, aHalf: h, aSide: side } = b.a;
      const at = (i) => [p[i * 3] + m[i * 2] * h[i], p[i * 3 + 1] + m[i * 2 + 1] * h[i], p[i * 3 + 2]];
      for (let i = 0; i < h.length; i += 1) if (b.roles[i] === "casing" && Math.abs(side[i]) === 1) edges.push(at(i));
      for (let i = 0; i < b.index.length; i += 3) {
        if ((b.roles[b.index[i]] ?? "fill") !== "fill") continue;
        const t = [at(b.index[i]), at(b.index[i + 1]), at(b.index[i + 2])];
        const area = Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1])) / 2;
        if (area < 1e-5) degenerate += 1; else top.push(t);
      }
    } else if (b.a.aAo) {
      const { normal: n, aAo: ao } = b.a;
      for (let i = 0; i < ao.length; i += 1) if (ao[i] === 1 && n[i * 3 + 2] === 0) walls.push({ p: [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]], n: [n[i * 3], n[i * 3 + 1]] });
      for (let i = 0; i < b.index.length; i += 3) {
        const [a, c, d] = [b.index[i], b.index[i + 1], b.index[i + 2]];
        if (n[a * 3 + 2] !== 0) continue;
        wallFaces += 1;
        const ux = p[c * 3] - p[a * 3], uy = p[c * 3 + 1] - p[a * 3 + 1], uz = p[c * 3 + 2] - p[a * 3 + 2];
        const vx = p[d * 3] - p[a * 3], vy = p[d * 3 + 1] - p[a * 3 + 1], vz = p[d * 3 + 2] - p[a * 3 + 2];
        const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz;
        const length = Math.hypot(fx, fy);
        if (length > 1e-6 && Math.abs((fx * n[a * 3] + fy * n[a * 3 + 1]) / length) < 0.5) wrongNormals += 1;
      }
    }
  }
  return { top, edges, walls, degenerate, wrongNormals, wallFaces };
}

export function surfaceZ(triangles, x, y) {
  let best = null;
  for (const [a, b, c] of triangles) {
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-9) continue;
    const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
    const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
    const w = 1 - u - v;
    if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
    const z = u * a[2] + v * b[2] + w * c[2];
    if (best === null || z > best) best = z;
  }
  return best;
}

/** Wysokość płyty obrysu mostu względem pomostów leżących nad nią. */
export function auditBridgePlates(engine) {
  const { model, features } = engine;
  const decks = [...model.states.values()].filter((s) => s.feature.geometry === "way" && s.interp.geometry === "line" && s.interp.classDef.surfaced && !s.interp.classDef.stairs && s.level?.z);
  const result = { plates: 0, samples: 0, maxBelowDeck: 0, maxAboveDeck: 0, aboveDeck: 0, worst: null };
  for (const s of model.states.values()) {
    if (s.interp.classId !== "structure.bridge" || s.interp.geometry !== "area") continue;
    const buckets = new Map();
    const bucket = (kind, def) => {
      const key = `${kind}|${def.tier}`;
      if (!buckets.has(key)) buckets.set(key, { kind, range: 0, index: [], count: 0, a: {}, roles: [], push(name, ...v) { (this.a[name] ??= []).push(...v); } });
      return buckets.get(key);
    };
    features._emit(s, bucket);
    const top = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of buckets.values()) {
      const { position: p, normal: n } = b.a;
      if (!n) continue;
      for (let i = 0; i < b.index.length; i += 3) {
        const [a, c, d] = [b.index[i], b.index[i + 1], b.index[i + 2]];
        if (n[a * 3 + 2] !== 1) continue;
        const t = [a, c, d].map((k) => [p[k * 3], p[k * 3 + 1], p[k * 3 + 2]]);
        top.push(t);
        for (const v of t) { minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]); minY = Math.min(minY, v[1]); maxY = Math.max(maxY, v[1]); }
      }
    }
    if (!top.length) continue;
    result.plates += 1;
    const layer = s.interp.attributes.layer;
    for (const d of decks) {
      if (d.level.lifted && d.level.units > 0 && layer !== undefined && d.interp.attributes.layer !== undefined && d.interp.attributes.layer !== layer) continue;
      const points = features.axisOf?.(d) ?? d.feature.points;
      for (let i = 0; i < points.length; i += 3) {
        const x = points[i], y = points[i + 1];
        if (x < minX || x > maxX || y < minY || y > maxY) continue;
        const z = surfaceZ(top, x, y);
        if (z === null) continue;
        const difference = z - d.level.z[i / 3];
        // Trasy biegnące pod mostem leżą znacznie niżej i płyta może je zasłaniać.
        if (Math.abs(difference) > 2.5) continue;
        result.samples += 1;
        result.maxBelowDeck = Math.max(result.maxBelowDeck, -difference);
        result.maxAboveDeck = Math.max(result.maxAboveDeck, difference);
        if (difference > 0.02) {
          result.aboveDeck += 1;
          if (!result.worst || difference > result.worst.difference) result.worst = { plate: s.feature.id, deck: d.feature.id, x: Math.round(x), y: Math.round(y), z: +d.level.z[i / 3].toFixed(2), difference: +difference.toFixed(2) };
        }
      }
    }
  }
  result.maxBelowDeck = +result.maxBelowDeck.toFixed(2); result.maxAboveDeck = +result.maxAboveDeck.toFixed(2);
  return result;
}

/** Odcinki ścian bocznych sięgające niżej niż grubość pomostu, czyli bryły zwisające pod trasą. */
export function auditHangingWalls(engine, { deckThickness = 1.3, tolerance = 0.25 } = {}) {
  const { model, features } = engine;
  const runs = [];
  for (const s of model.states.values()) {
    if (!isNetwork(s)) continue;
    const buckets = new Map();
    const bucket = (kind, def) => {
      const key = `${kind}|${def.tier}`;
      if (!buckets.has(key)) buckets.set(key, { kind, range: 0, index: [], count: 0, a: {}, roles: [], push(name, ...v) { (this.a[name] ??= []).push(...v); } });
      return buckets.get(key);
    };
    features._emit(s, bucket);
    for (const b of buckets.values()) {
      if (b.kind !== "solid" || !b.a.aAo) continue;
      const { position: p, aAo: ao } = b.a;
      let run = null, last = null;
      const close = () => { if (run) runs.push(run); run = null; };
      for (let i = 0; i + 1 < ao.length; i += 2) {
        if (ao[i] !== 1 || ao[i + 1] !== 0.25) continue;
        const x = p[i * 3], y = p[i * 3 + 1], height = p[i * 3 + 2] - p[(i + 1) * 3 + 2];
        const jump = last ? Math.hypot(x - last[0], y - last[1]) : 0;
        if (height > deckThickness + tolerance && jump < 40) {
          run ??= { id: s.feature.id, cls: s.interp.classId, kind: s.level.lifted ? "przyczółek pomostu" : "nasyp lub dojazd", x: Math.round(x), y: Math.round(y), z: +p[i * 3 + 2].toFixed(1), length: 0, maxHeight: 0 };
          run.length += jump; run.maxHeight = Math.max(run.maxHeight, height);
        } else close();
        last = [x, y];
      }
      close();
    }
  }
  const byKind = {};
  for (const r of runs) { byKind[r.kind] ??= { runs: 0, meters: 0, maxHeight: 0 }; byKind[r.kind].runs += 1; byKind[r.kind].meters += r.length; byKind[r.kind].maxHeight = Math.max(byKind[r.kind].maxHeight, r.maxHeight); }
  for (const v of Object.values(byKind)) { v.meters = Math.round(v.meters); v.maxHeight = +v.maxHeight.toFixed(2); }
  runs.sort((a, b) => b.maxHeight - a.maxHeight);
  return { runs: runs.length, ways: new Set(runs.map((r) => r.id)).size, byKind, worst: runs.slice(0, 14).map((r) => ({ ...r, length: Math.round(r.length), maxHeight: +r.maxHeight.toFixed(2) })) };
}

/** Niezależna kontrola podpór: styk z pomostem i terenem, kolizje oraz pochodzenie. */
export function auditSupports(engine) {
  const { model } = engine;
  const { items, stats } = model.supports, T = model.profile.inferredSupports.deckThicknessMeters;
  const out = { total: items.length, osm: stats.osm, inferred: stats.inferred, sharedStations: stats.shared, blocked: stats.blocked, lowClearanceStations: stats.lowClearance, waysWithoutSupport: stats.waysWithoutSupport, topContactOff: 0, maxTopOff: 0, groundContactOff: 0, maxGroundOff: 0, floatingOverDrawn: 0, maxFloatOverDrawn: 0, inRoute: 0, inBuilding: 0, inWater: 0, withTagsInModel: 0, pierSources: 0, heights: { min: Infinity, max: 0 }, examples: [] };
  const lines = [...model.states.values()].filter((s) => s.feature.geometry === "way" && s.interp.geometry === "line" && s.level && ["transport", "water"].includes(s.interp.classDef.levelCheck));
  const areas = [...model.states.values()].filter((s) => s.interp.geometry === "area" && (s.interp.classDef.render === "extrude" || s.interp.classId === "water.area"));
  const inside = (f, x, y) => {
    const polys = f.geometry === "multipolygon" ? f.polygons : [[Array.from({ length: f.points.length / 3 }, (_, i) => [f.points[i * 3], f.points[i * 3 + 1]]).flat()]];
    return polys.some((rings) => { const hit = (r) => { let c = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) if (r[i + 1] > y !== r[j + 1] > y && x < ((r[j] - r[i]) * (y - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) c = !c; return c; }; return hit(rings[0]) && !rings.slice(1).some(hit); });
  };
  for (const s of items) {
    out.heights.min = Math.min(out.heights.min, s.top - s.bottom); out.heights.max = Math.max(out.heights.max, s.top - s.bottom);
    if (model.states.has(s.id) ? s.source !== "osm" : s.source === "osm") out.withTagsInModel += 1;
    const deck = model.states.get(s.deckId);
    if (deck.feature.tags.man_made === "pier") out.pierSources += 1;
    const { points } = deck.feature, { z } = deck.level;
    let top = null, ground = null, best = Infinity;
    for (let i = 1; i < z.length; i += 1) {
      const ax = points[i * 3 - 3], ay = points[i * 3 - 2], dx = points[i * 3] - ax, dy = points[i * 3 + 1] - ay;
      const t = Math.max(0, Math.min(1, ((s.x - ax) * dx + (s.y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(s.x - ax - t * dx, s.y - ay - t * dy);
      if (d < best) { best = d; top = z[i - 1] + (z[i] - z[i - 1]) * t - T; ground = points[i * 3 - 1] + (points[i * 3 + 2] - points[i * 3 - 1]) * t; }
    }
    if (s.source === "inferred") {
      const topOff = Math.abs(top - s.top), groundOff = Math.abs(ground - s.bottom);
      out.maxTopOff = Math.max(out.maxTopOff, topOff); out.maxGroundOff = Math.max(out.maxGroundOff, groundOff);
      if (topOff > 0.02) out.topContactOff += 1;
      if (groundOff > 0.02) out.groundContactOff += 1;
    }
    // Rysowany teren (NMT dopasowany do tras) pod stopą: dół podpory nie może nad nim wisieć.
    const bottom = engine.features.supportBottom?.(s) ?? s.bottom;
    for (let k = 0; k <= 8; k += 1) {
      const r = k ? s.radius * 1.45 : 0, a = (k * Math.PI) / 4, g = engine.features.groundAt?.(s.x + r * Math.cos(a), s.y + r * Math.sin(a));
      if (Number.isFinite(g) && bottom > g + 0.02) { out.floatingOverDrawn += 1; out.maxFloatOverDrawn = Math.max(out.maxFloatOverDrawn, +(bottom - g).toFixed(2)); break; }
    }
    for (const line of lines) {
      if (line === deck) continue;
      const lp = line.feature.points, half = (line.interp.dimensions.width?.value ?? line.interp.classDef.widthMeters ?? 2) / 2;
      for (let i = 1; i < line.level.z.length; i += 1) {
        const ax = lp[i * 3 - 3], ay = lp[i * 3 - 2], dx = lp[i * 3] - ax, dy = lp[i * 3 + 1] - ay;
        if (Math.abs(s.x - ax) > 60 || Math.abs(s.y - ay) > 60) continue;
        const t = Math.max(0, Math.min(1, ((s.x - ax) * dx + (s.y - ay) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(s.x - ax - t * dx, s.y - ay - t * dy) >= half + s.radius) continue;
        if (line.level.z[i - 1] + (line.level.z[i] - line.level.z[i - 1]) * t < s.top - 0.3) { out.inRoute += 1; if (out.examples.length < 5) out.examples.push({ support: s.id, line: line.feature.id }); break; }
      }
    }
    for (const area of areas) if (inside(area.feature, s.x, s.y)) { if (area.interp.classDef.render === "extrude") out.inBuilding += 1; else out.inWater += 1; }
  }
  out.maxTopOff = +out.maxTopOff.toFixed(3); out.maxGroundOff = +out.maxGroundOff.toFixed(3);
  out.heights = { min: +out.heights.min.toFixed(1), max: +out.heights.max.toFixed(1) };
  return out;
}

function verticalOrder(interp) {
  const { layer, structure } = interp.attributes;
  if (layer !== undefined) return layer;
  if (structure === "bridge") return 1;
  if (structure === "tunnel") return -1;
  return 0;
}

/** Stopień między nawierzchniami jezdni stykających się bokiem na tym samym poziomie. */
export function auditLateralSteps(engine, { tolerance = 0.3 } = {}) {
  const { model, features } = engine;
  const ways = [...model.states.values()].filter(isNetwork);
  const CELL = 25, grid = new Map(), tops = new Map();
  for (const s of ways) {
    const top = sectionGeometry(features, s).top;
    tops.set(s.feature.id, top);
    for (const t of top) {
      const key = `${Math.floor(t[0][0] / CELL)}:${Math.floor(t[0][1] / CELL)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push({ s, t });
    }
  }
  const result = { sections: 0, contacts: 0, steps: 0, maxStep: 0, modelSteps: 0, maxModelStep: 0, realOrPathSteps: 0, pairs: 0, modelPairs: 0, worst: [] };
  const pairs = new Map();
  for (const s of ways) {
    const points = features.axisOf?.(s) ?? s.feature.points, { nodeRefs } = s.feature, { z } = s.level, refs = new Set(nodeRefs);
    const half = (s.interp.dimensions.width?.value ?? s.interp.classDef.widthMeters ?? 2) / 2, order = verticalOrder(s.interp);
    for (let i = 1; i < z.length - 1; i += 1) {
      let tx = points[i * 3 + 3] - points[i * 3 - 3], ty = points[i * 3 + 4] - points[i * 3 - 2];
      const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      result.sections += 1;
      for (const side of [-1, 1]) {
        const x = points[i * 3] - ty * side * (half + 0.4), y = points[i * 3 + 1] + tx * side * (half + 0.4);
        const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), hits = new Map();
        for (let a = cx - 1; a <= cx + 1; a += 1) for (let b = cy - 1; b <= cy + 1; b += 1) {
          for (const { s: other, t } of grid.get(`${a}:${b}`) ?? []) {
            if (other === s || verticalOrder(other.interp) !== order || other.feature.nodeRefs.some((r) => refs.has(r))) continue;
            const h = surfaceZ([t], x, y);
            if (h !== null) hits.set(other, Math.max(hits.get(other) ?? -Infinity, h));
          }
        }
        for (const [other, h] of hits) {
          result.contacts += 1;
          const step = Math.abs(h - z[i]);
          if (step <= tolerance) continue;
          const op = other.feature.points;
          let nearest = 0, best = Infinity;
          for (let k = 0; k < op.length; k += 3) { const d = (op[k] - x) ** 2 + (op[k + 1] - y) ** 2; if (d < best) { best = d; nearest = k; } }
          const roads = s.interp.classDef.carriageway && other.interp.classDef.carriageway;
          const decks = s.level.lifted || other.level.lifted;
          const sameGround = decks || Math.abs((op[nearest + 2] ?? 0) - (points[i * 3 + 2] ?? 0)) <= 1;
          const modelError = roads && sameGround;
          result.steps += 1; result.maxStep = Math.max(result.maxStep, step);
          if (modelError) { result.modelSteps += 1; result.maxModelStep = Math.max(result.maxModelStep, step); } else result.realOrPathSteps += 1;
          const key = [s.feature.id, other.feature.id].sort().join("+");
          const entry = pairs.get(key);
          if (!entry || step > entry.step) pairs.set(key, { pair: key, modelError, classes: `${s.interp.classId}+${other.interp.classId}`, step: +step.toFixed(2), x: Math.round(points[i * 3]), y: Math.round(points[i * 3 + 1]), z: +z[i].toFixed(2), kinds: `${s.level.lifted ? "most" : "teren"}+${other.level.lifted ? "most" : "teren"}` });
        }
      }
    }
  }
  result.pairs = pairs.size; result.maxStep = +result.maxStep.toFixed(2); result.maxModelStep = +result.maxModelStep.toFixed(2);
  result.modelPairs = [...pairs.values()].filter((p) => p.modelError).length;
  result.worst = [...pairs.values()].sort((a, b) => Number(b.modelError) - Number(a.modelError) || b.step - a.step).slice(0, 12);
  return result;
}

const hexToBytes = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Pomiar przekroju i rzeczywistych pikseli górnej nawierzchni na podniesionych trasach i nasypach. */
export function auditSurface(engine, { pixelSamples = 90 } = {}) {
  const { model, features, rig, renderer, camera, scene, shared } = engine;
  const ways = [...model.states.values()].filter(isElevated);
  const out = { elevatedWays: ways.length, sections: 0, holes: 0, maxSag: 0, sagOver5cm: 0, wallTopAboveSurfaceMax: 0, wallsAboveSurface: 0, wallEdgeOffsetMax: 0, wallsOffEdge: 0, degenerateTriangles: 0, wallFaces: 0, wrongWallNormals: 0, pixels: { checked: 0, surface: 0, sideOrCasing: 0, other: 0, coveredBy: {} } };
  const failures = [], candidates = [];
  for (const s of ways) {
    const g = sectionGeometry(features, s);
    out.degenerateTriangles += g.degenerate; out.wallFaces += g.wallFaces; out.wrongWallNormals += g.wrongNormals;
    const points = features.axisOf?.(s) ?? s.feature.points, { z } = s.level, n = z.length;
    const half = s.interp.dimensions.width?.value / 2 || (s.interp.classDef.widthMeters ?? 2) / 2;
    let along = 0;
    let total = 0;
    for (let i = 1; i < n; i += 1) total += Math.hypot(points[i * 3] - points[i * 3 - 3], points[i * 3 + 1] - points[i * 3 - 2]);
    for (let i = 1; i < n - 1; i += 1) {
      along += Math.hypot(points[i * 3] - points[i * 3 - 3], points[i * 3 + 1] - points[i * 3 - 2]);
      if (along < 25 || total - along < 25) continue;
      let tx = points[i * 3 + 3] - points[i * 3 - 3], ty = points[i * 3 + 4] - points[i * 3 - 2];
      const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      const x = points[i * 3], y = points[i * 3 + 1], nx = -ty, ny = tx;
      out.sections += 1;
      const heights = [-0.9, -0.5, 0, 0.5, 0.9].map((k) => surfaceZ(g.top, x + nx * half * k, y + ny * half * k));
      if (heights.some((h) => h === null)) { out.holes += 1; failures.push({ type: "dziura", id: s.feature.id, x: Math.round(x), y: Math.round(y) }); continue; }
      // Trasa dochodząca leży celowo do 6 cm niżej od głównej, aby jej nie przebijać.
      const sag = Math.max(...heights.map((h) => Math.max(0, z[i] - h - DECK_ORDER_TOLERANCE)));
      out.maxSag = Math.max(out.maxSag, sag);
      if (sag > 0.05) out.sagOver5cm += 1;
      for (const side of [-1, 1]) {
        const ex = x + nx * side * (half + 0.6), ey = y + ny * side * (half + 0.6);
        let wall = null, wallDistance = Infinity;
        for (const w of g.walls) { const d = Math.hypot(w.p[0] - ex, w.p[1] - ey); if (d < wallDistance) { wallDistance = d; wall = w; } }
        if (!wall || wallDistance > 12) continue;
        // Porównanie w tym samym przekroju co bok: tuż do środka od jego górnej krawędzi.
        const surface = surfaceZ(g.top, wall.p[0] - wall.n[0] * 0.7, wall.p[1] - wall.n[1] * 0.7);
        if (surface !== null) {
          const above = wall.p[2] - surface;
          out.wallTopAboveSurfaceMax = Math.max(out.wallTopAboveSurfaceMax, above);
          if (above > 0.03) out.wallsAboveSurface += 1;
        }
        let edgeGap = Infinity;
        for (const e of g.edges) edgeGap = Math.min(edgeGap, Math.hypot(e[0] - wall.p[0], e[1] - wall.p[1], e[2] - wall.p[2]));
        if (Number.isFinite(edgeGap)) { out.wallEdgeOffsetMax = Math.max(out.wallEdgeOffsetMax, edgeGap); if (edgeGap > 0.03) out.wallsOffEdge += 1; }
      }
      if (i % 4 === 0 && !s.interp.attributes.routeMark) candidates.push({ s, x, y, z: z[i], tx, ty, nx, ny, half });
    }
  }

  const step = Math.max(1, Math.floor(candidates.length / pixelSamples));
  const saved = { x: rig.target.x, y: rig.target.y, z: rig.target.z, d: rig.distance, t: rig.tilt, a: rig.azimuth };
  const markers = engine.markers.visible;
  engine.markers.visible = false;
  // Linie i oznakowanie są osobnymi warstwami; tu oceniana jest sama nawierzchnia.
  const overlayGroups = Object.keys(model.profile.groups).filter((g) => model.profile.groups[g].parent), alreadyHidden = new Set(features.hiddenGroups);
  overlayGroups.forEach((g) => features.hiddenGroups.add(g));
  const buffer = renderer.domElement, pixel = new Uint8Array(4), selected = shared.uSelected.value.clone();
  shared.uSelected.value.set(-1, -1, -1);
  for (let c = 0; c < candidates.length; c += step) {
    const q = candidates[c], def = q.s.interp.classDef;
    rig.target.set(q.x, q.y, q.z); rig.distance = 26; rig.tilt = 1.05; rig.azimuth = Math.atan2(q.tx, q.ty) + 1.05; rig.apply();
    features.updateLod(camera.position);
    const material = model.surfaces.byId.get(q.s.feature.id).material;
    const fill = hexToBytes(material.color), accent = hexToBytes(material.accent), casing = accent;
    for (const k of [0, 0.5, -0.5]) {
      const sx = q.x + q.nx * q.half * k, sy = q.y + q.ny * q.half * k;
      const v = camera.position.clone().set(sx, sy, q.z).project(camera);
      const px = Math.floor(((v.x + 1) / 2) * buffer.width), py = Math.floor(((1 - v.y) / 2) * buffer.height);
      if (px < 0 || py < 0 || px >= buffer.width || py >= buffer.height) continue;
      camera.setViewOffset(buffer.width, buffer.height, px, py, 1, 1);
      renderer.setRenderTarget(engine.pickTarget); renderer.clear(); renderer.render(scene, camera);
      renderer.readRenderTargetPixels(engine.pickTarget, 0, 0, 1, 1, pixel);
      renderer.setRenderTarget(null); camera.clearViewOffset();
      const dist = (o) => Math.hypot(pixel[0] - o[0], pixel[1] - o[1], pixel[2] - o[2]);
      out.pixels.checked += 1;
      // Faktura miesza kolor bazowy z akcentem, więc poprawny piksel leży między nimi.
      const axis = accent.map((v, k) => v - fill[k]), span = axis.reduce((sum, v) => sum + v * v, 0) || 1, along = Math.max(0, Math.min(1, axis.reduce((sum, v, k) => sum + v * (pixel[k] - fill[k]), 0) / span));
      if (dist(fill.map((v, k) => v + axis[k] * along)) <= 16) { out.pixels.surface += 1; continue; }
      // Inny obiekt nad tą jezdnią, np. wyższy wiadukt, nie jest błędem jej nawierzchni.
      const color = [...pixel.slice(0, 3)];
      camera.setViewOffset(buffer.width, buffer.height, px, py, 1, 1);
      shared.uPick.value = 1;
      renderer.setRenderTarget(engine.pickTarget); renderer.clear(); renderer.render(scene, camera);
      renderer.readRenderTargetPixels(engine.pickTarget, 0, 0, 1, 1, pixel);
      renderer.setRenderTarget(null); camera.clearViewOffset(); shared.uPick.value = 0;
      const seen = features.featureFromPick(pixel[0] | (pixel[1] << 8) | (pixel[2] << 16));
      if (seen === q.s.feature.id) { out.pixels.sideOrCasing += 1; failures.push({ type: "bok lub obwódka zamiast nawierzchni", id: seen, x: Math.round(sx), y: Math.round(sy), z: +q.z.toFixed(2), azimuth: +rig.azimuth.toFixed(2), rgb: color }); }
      else { out.pixels.other += 1; out.pixels.coveredBy[model.states.get(seen)?.interp.classId ?? "brak"] = (out.pixels.coveredBy[model.states.get(seen)?.interp.classId ?? "brak"] ?? 0) + 1; }
    }
  }
  shared.uSelected.value.copy(selected);
  engine.markers.visible = markers;
  features.hiddenGroups = alreadyHidden;
  rig.target.set(saved.x, saved.y, saved.z); rig.distance = saved.d; rig.tilt = saved.t; rig.azimuth = saved.a; rig.apply();
  features.updateLod(camera.position);
  engine.invalidate();
  for (const key of ["maxSag", "wallTopAboveSurfaceMax", "wallEdgeOffsetMax"]) out[key] = +out[key].toFixed(3);
  return { ...out, failures: failures.slice(0, 12) };
}

export const AUDIT_CAMERAS = [
  { x: -725, y: -255, d: 300, t: 1.1, a: 0.6 }, { x: 1260, y: 1500, d: 320, t: 1.1, a: -0.5 },
  { x: 0, y: 0, d: 2200, t: 0.9, a: 0.2 }, { x: 500, y: 600, d: 4200, t: 0.8, a: 1 }, { x: -1400, y: -700, d: 6500, t: 0.7, a: 2 },
];

export function auditNetwork(engine) {
  const continuity = auditContinuity(engine.model);
  return {
    osmTopology: continuity.topology,
    heights: { nodesWithJump: continuity.heightJumps.count, maxJump: continuity.heightJumps.max, steep: continuity.steepSegments.count, crossingsChecked: continuity.separation.checked, belowClearance: continuity.separation.belowMinimum, wrongOrder: continuity.separation.wrongOrder, minGap: continuity.separation.worst[0]?.gap ?? null },
    joints: geometryAudit(engine),
    lod: lodAudit(engine, AUDIT_CAMERAS),
    terrainTiles: terrainAudit(engine),
  };
}

/**
 * Linie krawędziowe na skrzyżowaniach (konsola). Skrzyżowanie trójwlotowe: dwie jezdnie na wprost i jedna boczna.
 * Po stronie przeciwnej do wlotu linia ma przechodzić przez węzeł (przerwa ≤ 0,5 m), a po stronie wlotu być przerwana
 * mniej więcej na szerokości drogi bocznej. Dodatkowo żaden punkt rysowanej linii nie może leżeć na innej jezdni
 * tego samego poziomu poza kontynuacją i gałęzią rozwidlenia.
 */
export function auditEdgeLines(engine) {
  const model = engine.model, plans = model.surfaces.byId;
  const lineHalf = (model.profile.surfaces.edgeLineInsetMeters ?? 0) + model.profile.surfaces.edgeLineWidthMeters / 2;
  const out = { lines: 0, km: 0, tJunctions: 0, throughGaps: [], mouthMissing: [], insideOther: 0 };
  const widthAt = (plan, s) => plan.widthStart !== undefined ? plan.widthStart + (plan.widthEnd - plan.widthStart) * (plan.length ? s / plan.length : 0) : plan.width;
  for (const plan of plans.values()) if (plan.edgeLine) { out.lines += 1; for (const side of plan.edgeLine.sides) for (const [a, b] of side.pieces) out.km += (b - a) / 1000; }
  // Końce jezdni w węzłach.
  const ends = new Map();
  for (const plan of plans.values()) {
    const state = model.states.get(plan.id);
    if (!state.interp.classDef.carriageway) continue;
    const refs = state.feature.nodeRefs, a = plan.axis, n = a.length / 3;
    for (const atStart of [true, false]) {
      const i = atStart ? 0 : n - 1, j = atStart ? 1 : n - 2, l = Math.hypot(a[j * 3] - a[i * 3], a[j * 3 + 1] - a[i * 3 + 1]) || 1;
      const ref = atStart ? refs[0] : refs[refs.length - 1];
      if (!ends.has(ref)) ends.set(ref, []);
      ends.get(ref).push({ plan, atStart, hx: (a[j * 3] - a[i * 3]) / l, hy: (a[j * 3 + 1] - a[i * 3 + 1]) / l, x: a[i * 3], y: a[i * 3 + 1] });
    }
  }
  // Odległość od węzła do początku linii po danej stronie (strona względem kierunku od węzła w głąb jezdni: +1 prawa).
  const setback = (e, sideAway) => {
    const sides = e.plan.edgeLine?.sides;
    if (!sides) return null;
    const side = e.atStart ? sideAway : -sideAway, pieces = sides.find((s) => s.side === side)?.pieces ?? [];
    if (!pieces.length) return Infinity;
    return e.atStart ? pieces[0][0] : e.plan.length - pieces[pieces.length - 1][1];
  };
  const edgePoint = (plan, side, s) => {
    const { axis, along } = plan;
    let k = 1;
    while (k < along.length - 1 && along[k] < s) k += 1;
    const f = Math.max(0, Math.min(1, (s - along[k - 1]) / ((along[k] - along[k - 1]) || 1)));
    const dx = axis[k * 3] - axis[k * 3 - 3], dy = axis[k * 3 + 1] - axis[k * 3 - 2], l = Math.hypot(dx, dy) || 1, off = side * (widthAt(plan, s) / 2 - lineHalf);
    return [axis[k * 3 - 3] + dx * f + (dy / l) * off, axis[k * 3 - 2] + dy * f - (dx / l) * off];
  };
  // Czy któraś linia krawędziowa jezdni przechodzi bliżej niż r od punktu.
  const lineNear = (plan, [x, y], r) => (plan.edgeLine?.sides ?? []).some((line) => line.pieces.some(([a, b]) => {
    for (let s = a; s <= b; s += 0.25) { const q = edgePoint(plan, line.side, s); if (Math.hypot(q[0] - x, q[1] - y) < r) return true; }
    return false;
  }));
  // Punkt na osi drogi bocznej, w którym oddala się ona od osi jezdni głównej na odległość jej linii krawędziowej.
  const mouthPoint = (side, main) => {
    const p = side.plan.axis, n = p.length / 3, order = side.atStart ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
    const target = widthAt(main.plan, main.atStart ? 0 : main.plan.length) / 2 - lineHalf, m = main.plan.axis;
    const fromMain = (x, y) => { let best = Infinity; for (let i = 3; i < m.length; i += 3) { const ax = m[i - 3], ay = m[i - 2], dx = m[i] - ax, dy = m[i + 1] - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1))); best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t)); } return best; };
    for (let j = 1; j < order.length; j += 1) {
      const a = order[j - 1], b = order[j], ax = p[a * 3], ay = p[a * 3 + 1], bx = p[b * 3], by = p[b * 3 + 1], l = Math.hypot(bx - ax, by - ay);
      for (let s = 0; s <= l; s += 0.1) { const x = ax + (bx - ax) * (s / (l || 1)), y = ay + (by - ay) * (s / (l || 1)); if (fromMain(x, y) >= target) return [x, y]; }
    }
    return null;
  };
  for (const [ref, list] of ends) {
    if (list.length !== 3) continue;
    for (let i = 0; i < 3; i += 1) for (let j = i + 1; j < 3; j += 1) {
      const a = list[i], b = list[j], side = list[3 - i - j];
      if (a.hx * b.hx + a.hy * b.hy > -0.9 || !a.plan.edgeLine || !b.plan.edgeLine) continue;
      // Wlot boczny: co najmniej 45° od drogi przelotowej i bez rozwidlenia (rozwidlenie ma linię wzdłuż gałęzi).
      const cross = a.hx * side.hy - a.hy * side.hx;
      if (Math.abs(cross) < Math.SQRT1_2 || list.some((e) => e.plan.forks || e.plan.forkTotal)) continue;
      out.tJunctions += 1;
      // Strona wlotu względem kierunku od węzła w głąb jezdni a: znak iloczynu wektorowego.
      const mouthSideA = cross < 0 ? 1 : -1;
      const far = (setback(a, -mouthSideA) ?? 0) + (setback(b, mouthSideA) ?? 0);
      if (far > 0.5) out.throughGaps.push({ node: ref, gap: +far.toFixed(2), ways: [a.plan.id, b.plan.id, side.plan.id] });
      // Wlot leży tam, gdzie oś drogi bocznej przecina linię krawędziową (przy dojeździe pod ukosem nie przy samym węźle).
      const sideWidth = widthAt(side.plan, side.atStart ? 0 : side.plan.length), mouth = mouthPoint(side, a);
      if (mouth && [a, b].some((e) => lineNear(e.plan, mouth, sideWidth * 0.3))) out.mouthMissing.push({ node: ref, at: mouth.map(Math.round), sideWidth, ways: [a.plan.id, b.plan.id, side.plan.id] });
    }
  }
  out.km = +out.km.toFixed(1);
  return out;
}

/**
 * Zgodność linii krawędziowych z bokiem rysowanej nawierzchni (konsola). Dla każdego punktu linii mierzona jest odległość
 * od boku nawierzchni tej jezdni; poprawna wynosi połowę szerokości linii. Punkty przy końcach jezdni (w strefie węzła,
 * gdzie nawierzchnię przycina skrzyżowanie) są liczone osobno.
 */
export function auditEdgeAlignment(engine, { tolerance = 0.1 } = {}) {
  const { model, features } = engine, lineHalf = model.profile.surfaces.edgeLineWidthMeters / 2, expected = (model.profile.surfaces.edgeLineInsetMeters ?? 0) + lineHalf;
  const out = { points: 0, off: 0, offAtEnds: 0, maxOff: 0, worst: [] };
  for (const plan of model.surfaces.byId.values()) {
    if (!plan.edgeLine?.sides.some((s) => s.pieces.length)) continue;
    const state = model.states.get(plan.id), buckets = new Map();
    const bucket = (kind, def) => { const key = `${kind}|${def.tier}`; if (!buckets.has(key)) buckets.set(key, { kind, range: 0, index: [], count: 0, a: {}, roles: [], push(name, ...v) { (this.a[name] ??= []).push(...v); } }); return buckets.get(key); };
    features._emit(state, bucket);
    const edges = [], points = [];
    for (const b of buckets.values()) {
      if (!b.a.aMiter) continue;
      const { position: p, aMiter: m, aHalf: h, aSide: side } = b.a;
      if (b.kind === "ground" || b.kind === "raised") {
        const last = {};
        for (let i = 0; i < h.length; i += 1) {
          if ((b.roles[i] ?? "fill") !== "fill" || Math.abs(side[i]) !== 1) continue;
          const q = [p[i * 3] + m[i * 2] * h[i], p[i * 3 + 1] + m[i * 2 + 1] * h[i]];
          if (last[side[i]]) edges.push([...last[side[i]], ...q]);
          last[side[i]] = q;
        }
      }
      // Linia krawędziowa: pociągnięcie oznakowania o połowie szerokości linii krawędziowej.
      if (b.kind === "markGround" || b.kind === "mark") for (let i = 0; i < h.length; i += 1) if (b.roles[i] === "marking" && Math.abs(side[i]) === 1 && Math.abs(h[i] - lineHalf) < 0.005) points.push([p[i * 3], p[i * 3 + 1]]);
    }
    const axis = plan.axis, ends = [[axis[0], axis[1]], [axis[axis.length - 3], axis[axis.length - 2]]], reach = plan.width / 2 + 1.5;
    for (const [x, y] of points) {
      let best = Infinity;
      for (const [ax, ay, bx, by] of edges) { const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1))); best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t)); }
      if (best > 1) continue; // linia pasa w głębi jezdni
      out.points += 1;
      const off = Math.abs(best - expected);
      if (off <= tolerance) continue;
      if (ends.some(([ex, ey]) => Math.hypot(x - ex, y - ey) < reach)) { out.offAtEnds += 1; continue; }
      out.off += 1; out.maxOff = Math.max(out.maxOff, +off.toFixed(2));
      if (out.worst.length < 12) out.worst.push({ id: plan.id, off: +off.toFixed(2), at: [Math.round(x), Math.round(y)] });
    }
  }
  return out;
}
