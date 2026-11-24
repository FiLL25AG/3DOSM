// Parametryczny model schodów OSM. Liczy wyłącznie z tagów, poziomów sieci i jawnych założeń profilu.
// Końce biegu leżą na wysokościach węzłów, dlatego schody zawsze stykają się z dojściami.

const round = (value, digits = 3) => Number(value.toFixed(digits));
const MAX_CONTACT_SHARE = 0.6, MIN_CROSSING_SINE = 0.5, STRAIGHT_COS = 0.7;

function parseIncline(raw) {
  if (raw === undefined) return { direction: 0, source: null, recognised: true };
  const text = raw.trim().toLowerCase();
  if (text === "up") return { direction: 1, source: "tag incline", recognised: true };
  if (text === "down") return { direction: -1, source: "tag incline", recognised: true };
  const match = /^([+-]?\d+(?:\.\d+)?)\s*(%|°)$/.exec(text);
  if (match && Number(match[1]) !== 0) return { direction: Math.sign(Number(match[1])), source: "tag incline", recognised: true };
  return { direction: 0, source: null, recognised: false };
}

function buildAlong(points) {
  const along = [0];
  for (let i = 3; i < points.length; i += 3) along.push(along[along.length - 1] + Math.hypot(points[i] - points[i - 3], points[i + 1] - points[i - 2]));
  return along;
}

/** Punkt i kierunek osi schodów w odległości `s` od początku wayu. */
export function stairPoint(plan, s) {
  const { points, along } = plan;
  let i = 1;
  while (i < along.length - 1 && along[i] < s) i += 1;
  const a = (i - 1) * 3, b = i * 3, span = along[i] - along[i - 1] || 1, t = Math.max(0, Math.min(1, (s - along[i - 1]) / span));
  const dx = points[b] - points[a], dy = points[b + 1] - points[a + 1], l = Math.hypot(dx, dy) || 1;
  return { x: points[a] + dx * t, y: points[a + 1] + dy * t, tx: dx / l, ty: dy / l, ground: points[a + 2] === null || points[b + 2] === null ? null : points[a + 2] + (points[b + 2] - points[a + 2]) * t };
}

export function planStair(state, profile, contact = { start: 0, end: 0 }) {
  const cfg = profile.steps, { feature, interp, level, tagsNow: tags } = state, { attributes } = interp;
  const { points } = feature, along = buildAlong(points), length = along[along.length - 1];
  const zStart = level.z[0], zEnd = level.z[level.z.length - 1], delta = zEnd - zStart, rise = Math.abs(delta);
  const flat = rise < cfg.flatRiseMeters, uphillForward = delta >= 0;
  const incline = parseIncline(tags.incline), notes = [];

  // Bieg zaczyna się na krawędzi trasy, do której dochodzi, a nie na jej osi wewnątrz nawierzchni.
  let lowTrim = uphillForward ? contact.start : contact.end, highTrim = uphillForward ? contact.end : contact.start;
  const limitTrims = (available) => {
    const total = lowTrim + highTrim;
    if (total > available) { const k = available / total; lowTrim *= k; highTrim *= k; }
  };
  limitTrims(length * MAX_CONTACT_SHARE);
  let run = length - lowTrim - highTrim;

  let count, countSource, countApproximate;
  if (attributes.stepCount !== undefined) {
    count = attributes.stepCount; countSource = "tag step_count"; countApproximate = false;
    limitTrims(Math.max(0, length - count * cfg.minTreadMeters));
    run = length - lowTrim - highTrim;
  } else {
    const byTread = Math.max(1, Math.floor(run / cfg.minTreadMeters));
    const wanted = flat ? Math.round(run / cfg.defaultTreadMeters) : Math.round(rise / cfg.defaultRiserMeters);
    count = Math.max(1, Math.min(wanted, byTread));
    countSource = flat ? "założenie: długość / głębokość stopnia" : "założenie: wysokość biegu / wysokość stopnia";
    countApproximate = true;
  }

  let landings = 0;
  if (count > cfg.landingEverySteps) {
    const wanted = Math.floor((count - 1) / cfg.landingEverySteps);
    if (run - wanted * cfg.landingLengthMeters >= count * cfg.minTreadMeters) landings = wanted;
    else notes.push("Za mało długości na spoczniki z założenia profilu.");
  }
  const tread = (run - landings * cfg.landingLengthMeters) / count;
  const riser = rise / count;
  const lowZ = Math.min(zStart, zEnd);
  const toWay = (d) => (uphillForward ? d : length - d);

  // Stopnie liczone od dolnego końca: najwyższy kończy się na wysokości górnego węzła.
  const segments = [];
  let distance = lowTrim;
  const flightSize = landings ? Math.ceil(count / (landings + 1)) : count;
  for (let i = 0; i < count; i += 1) {
    const top = lowZ + (i + 1) * riser;
    segments.push({ kind: "tread", from: distance, to: distance + tread, z: top, bottom: top - riser, index: i });
    distance += tread;
    if (landings && (i + 1) % flightSize === 0 && i + 1 < count && segments.filter((s) => s.kind === "landing").length < landings) {
      segments.push({ kind: "landing", from: distance, to: distance + cfg.landingLengthMeters, z: top, bottom: top, index: i });
      distance += cfg.landingLengthMeters;
    }
  }

  const surface = tags.surface;
  const surfaces = profile.surfaces;
  const mapped = surface === undefined ? undefined : surfaces.surfaceMaterials[surface];
  const materialId = mapped ?? surfaces.defaultMaterial;
  const width = interp.dimensions.width;
  const fromTag = attributes.stepHeight;
  const issues = [];
  const issue = (code, severity, confidence, message, reason, suggest = []) => issues.push({ key: `${code}:${feature.id}`, code, category: "uncertain", status: "informacja", severity, confidence, message, reason, objects: [feature.id], location: [points[0], points[1], zStart], suggest });
  const doc = (key, reason) => ({ key, reason, doc: `https://wiki.openstreetmap.org/wiki/Key:${key}` });

  if (!incline.recognised) issue("steps-incline-value", 1, "wysoka", `Nierozpoznana wartość incline: „${tags.incline}”.`, "Kierunek schodów wynika wtedy tylko z wysokości sieci.", [doc("incline", "Wartość up lub down względem kierunku wayu.")]);
  if (incline.direction && !flat && incline.direction !== Math.sign(delta)) issue("steps-incline-conflict", 2, "średnia", `Tag incline wskazuje kierunek ${incline.direction > 0 ? "w górę" : "w dół"}, a wysokości sieci przeciwny.`, "Stopnie pokazano według wysokości sieci, a tagu nie zmieniono. Sprawdź kierunek wayu lub wartość incline.", [doc("incline", "Kierunek względem wayu.")]);
  if (flat) issue("steps-flat", 1, "średnia", "Model terenu i sieci nie pokazuje różnicy wysokości na tych schodach.", "Stopnie mają zerową wysokość, a ich liczba jest tylko podziałem biegu.", [doc("step_count", "Liczba stopni.")]);
  else if (riser < cfg.minRiserMeters || riser > cfg.maxRiserMeters) issue("steps-riser", 1, "średnia", `Wyliczona wysokość stopnia ${riser.toFixed(2)} m jest poza zakresem profilu ${cfg.minRiserMeters}–${cfg.maxRiserMeters} m.`, "Różnica wysokości pochodzi z modelu sieci i może być przybliżona; liczba stopni może też być niepełna.", [doc("step_count", "Liczba stopni zmniejsza niepewność.")]);
  if (fromTag !== undefined && !flat && Math.abs(fromTag - riser) > 0.04) issue("steps-height-mismatch", 1, "średnia", `Tag step:height (${fromTag} m) różni się od wysokości wynikającej z biegu (${riser.toFixed(2)} m).`, "Końce schodów muszą stykać się z dojściami, więc obowiązuje wysokość sieci.", []);

  return {
    id: feature.id, points, along, length, rise, count, riser, tread, width: width?.value ?? 2, landings, segments, toWay, flat, uphillForward, lowTrim, highTrim,
    materialId, material: surfaces.materials[materialId],
    // Linia ma tę samą szerokość co linia przebiegu dojścia, więc przechodzi na schody bez uskoku.
    overlay: { color: interp.classDef.lineColor ?? interp.classDef.color, half: Math.min(surfaces.routeLineMaxWidthMeters, Math.max(surfaces.routeLineMinWidthMeters, (width?.value ?? 2) * surfaces.routeLineWidthRatio)) / 2, minPixels: surfaces.routeLineMinPixels },
    provenance: {
      count: { value: count, source: countSource, approximate: countApproximate },
      riser: { value: round(riser), source: fromTag !== undefined ? `różnica wysokości / liczba stopni (tag step:height: ${fromTag} m)` : "różnica wysokości sieci / liczba stopni", approximate: true },
      tread: { value: round(tread), source: "długość biegu / liczba stopni", approximate: true },
      width: { value: width?.value ?? 2, source: width?.source ?? "założenie", approximate: width?.approximate ?? true },
      direction: { value: flat ? "nieustalony" : uphillForward ? "w górę wzdłuż wayu" : "w dół wzdłuż wayu", source: flat ? (incline.source ?? "brak danych") : incline.source && incline.direction === Math.sign(delta) ? "tag incline i wysokości sieci" : "wysokości sieci", approximate: !incline.source },
      landings: { value: landings, source: landings ? `założenie profilu: co ${cfg.landingEverySteps} stopni` : "brak spocznika", approximate: landings > 0 },
      material: { value: surfaces.materials[materialId].label, source: mapped ? `tag surface=${surface}` : surface ? `nieznane surface=${surface}` : "założenie: brak tagu surface", approximate: !mapped },
    },
    notes, issues,
  };
}

/** Odległość od węzła do krawędzi tras w nim stykających się, mierzona wzdłuż kierunku schodów. */
function contactDistances(model) {
  const isStair = (s) => s.interp.classDef.stairs && s.feature.geometry === "way" && s.interp.geometry === "line" && s.level;
  const wanted = new Set(), uses = new Map();
  for (const state of model.states.values()) if (isStair(state)) { const refs = state.feature.nodeRefs; wanted.add(refs[0]); wanted.add(refs[refs.length - 1]); }
  for (const state of model.states.values()) {
    const { feature, interp } = state;
    if (feature.geometry !== "way" || interp.geometry !== "line" || !interp.classDef.surfaced || interp.classDef.stairs) continue;
    feature.nodeRefs.forEach((ref, position) => {
      if (!wanted.has(ref)) return;
      if (!uses.has(ref)) uses.set(ref, []);
      uses.get(ref).push({ state, k: feature.nodeIndex[position], atEnd: position === 0 || position === feature.nodeRefs.length - 1 });
    });
  }
  const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
  const distanceAt = (ref, wx, wy) => {
    let best = 0;
    for (const { state, k, atEnd } of uses.get(ref) ?? []) {
      const points = model.surfaces?.byId.get(state.feature.id)?.axis ?? state.feature.points, n = points.length / 3;
      const half = (state.interp.dimensions.width?.value ?? state.interp.classDef.widthMeters ?? 2) / 2;
      const p = Math.max(0, k - 1), q = Math.min(n - 1, k + 1), [tx, ty] = unit(points[q * 3] - points[p * 3], points[q * 3 + 1] - points[p * 3 + 1]);
      if (atEnd) {
        // Dojście kończące się w węźle i biegnące na wprost przechodzi w schody bez przesunięcia.
        const inward = k === 0 ? 1 : -1;
        if ((tx * wx + ty * wy) * inward < -STRAIGHT_COS) continue;
      }
      best = Math.max(best, half / Math.max(Math.abs(tx * wy - ty * wx), MIN_CROSSING_SINE));
    }
    return best;
  };
  return (state) => {
    const { points, nodeRefs } = state.feature, n = points.length / 3;
    const [ax, ay] = unit(points[3] - points[0], points[4] - points[1]), [bx, by] = unit(points[(n - 2) * 3] - points[(n - 1) * 3], points[(n - 2) * 3 + 1] - points[(n - 1) * 3 + 1]);
    return { start: distanceAt(nodeRefs[0], ax, ay), end: distanceAt(nodeRefs[nodeRefs.length - 1], bx, by) };
  };
}

export function planAllStairs(model) {
  const byId = new Map(), issues = [], stats = { total: 0, withCount: 0, withSurface: 0, withIncline: 0, flat: 0, landings: 0, steps: 0, materials: {} };
  const contactOf = contactDistances(model);
  for (const state of model.states.values()) {
    if (!state.interp.classDef.stairs || state.feature.geometry !== "way" || state.interp.geometry !== "line" || !state.level) continue;
    const plan = planStair(state, model.profile, contactOf(state));
    byId.set(state.feature.id, plan);
    issues.push(...plan.issues);
    stats.total += 1; stats.steps += plan.count; stats.landings += plan.landings;
    if (!plan.provenance.count.approximate) stats.withCount += 1;
    if (state.tagsNow.surface) stats.withSurface += 1;
    if (state.tagsNow.incline) stats.withIncline += 1;
    if (plan.flat) stats.flat += 1;
    stats.materials[plan.materialId] = (stats.materials[plan.materialId] ?? 0) + 1;
  }
  return { byId, issues, stats };
}
