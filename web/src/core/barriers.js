// Bariery liniowe, bramy i przejścia. Wymiary pochodzą z tagów; gdy ich brak, z typu w profilu kraju, a przy nieznanym typie z wartości domyślnej.

const OPENING_WIDTH_KEYS = ["maxwidth:physical", "maxwidth", "width"];
const MIN_WALL_METERS = 0.2;
// Odległości od osi ściany oporowej, w których odczytywany jest teren po obu stronach (NMT 1 m rozmywa uskok na ok. 1–2 m):
// po niższej stronie liczy się najniższy, a po wyższej najwyższy odczyt.
export const RETAINING_PROBE_METERS = [1, 2, 3];

function parseLength(raw) {
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*(m|cm)?\s*$/.exec(raw ?? "");
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  return match[2] === "cm" ? value / 100 : value;
}

function buildAlong(points) {
  const along = [0];
  for (let i = 3; i < points.length; i += 3) along.push(along[along.length - 1] + Math.hypot(points[i] - points[i - 3], points[i + 1] - points[i - 2]));
  return along;
}

const isBarrierWay = (state) => state.feature.geometry === "way" && state.interp.geometry === "line" && state.tagsNow.barrier !== undefined;
const isBarrierNode = (state) => state.feature.geometry === "point" && state.tagsNow.barrier !== undefined;
const isRoute = (state) => state.feature.geometry === "way" && state.interp.geometry === "line" && state.interp.classDef.surfaced && !state.interp.classDef.stairs;
const widthOf = (state) => state.interp.dimensions.width?.value ?? state.interp.classDef.widthMeters ?? 2;

/** Specyfikacja typu: wariant z tagu uściśla typ, a nieznany typ przyjmuje wartości domyślne profilu. */
function specOf(table, tags, cfg) {
  const base = table[tags.barrier], variant = base?.variants && Object.entries(base.variants).flatMap(([key, values]) => (values[tags[key]] ? [{ key, value: tags[key], spec: values[tags[key]] }] : []))[0];
  const material = cfg.materials[tags.material];
  const spec = { ...cfg.fallback, ...(base ?? {}), ...(variant?.spec ?? {}), ...(material ?? {}) };
  delete spec.variants;
  const known = Boolean(base);
  const heightSource = variant?.spec.height !== undefined ? `założenie profilu dla ${variant.key}=${variant.value}` : known ? `założenie profilu dla barrier=${tags.barrier}` : "typ nieokreślony w profilu: wartość domyślna";
  return { spec, known, heightSource, label: variant?.spec.label ?? base?.label ?? `Bariera (${tags.barrier})` };
}

function dimension(tags, key, fallback, fallbackSource, issue) {
  if (tags[key] !== undefined) {
    const value = parseLength(tags[key]);
    if (value !== null && value > 0) return { value, source: `tag ${key}`, approximate: false };
    issue(`Nieprawidłowa wartość ${key}=${tags[key]}.`, key);
  }
  return { value: fallback, source: fallbackSource, approximate: true };
}

/** Położenie punktu wzdłuż linii (m od początku), w rzucie na najbliższy odcinek. */
function stationOf(points, along, x, y) {
  let best = Infinity, station = 0;
  for (let i = 3; i < points.length; i += 3) {
    const ax = points[i - 3], ay = points[i - 2], dx = points[i] - ax, dy = points[i + 1] - ay, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)), d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
    if (d < best) { best = d; station = along[i / 3 - 1] + Math.sqrt(l2) * t; }
  }
  return station;
}

function tangentAt(points, k) {
  const n = points.length / 3, p = Math.max(0, k - 1), q = Math.min(n - 1, k + 1);
  const dx = points[q * 3] - points[p * 3], dy = points[q * 3 + 1] - points[p * 3 + 1], l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

/** Poziom trasy do porównania z barierą: layer, a gdy go brak, tunel jest poniżej (−1), most powyżej (+1) gruntu. */
function orderOf(tags) {
  const layer = Number(tags.layer);
  if (Number.isFinite(layer) && tags.layer !== undefined) return layer;
  if (tags.tunnel !== undefined && tags.tunnel !== "no") return -1;
  if (tags.bridge !== undefined && tags.bridge !== "no") return 1;
  return 0;
}

export function planAllBarriers(model) {
  const cfg = model.profile.barriers, byId = new Map(), issues = [], routesAt = new Map(), waysAt = new Map(), nodes = new Map();
  // Trasy przecinające barierę bez wspólnego węzła (z indeksu przestrzennego): niżej położona trasa przechodzi pod barierą.
  const crossingsOf = new Map();
  for (const c of model.index?.crossings ?? []) {
    if (c.sharedNode) continue;
    for (const [a, b] of [[c.a, c.b], [c.b, c.a]]) { if (!crossingsOf.has(a)) crossingsOf.set(a, []); crossingsOf.get(a).push({ id: b, x: c.x, y: c.y }); }
  }
  const stats = { ways: 0, nodes: 0, tagHeight: 0, typeHeight: 0, defaultHeight: 0, openings: 0, untaggedPassages: 0, types: {} };
  const add = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
  for (const state of model.states.values()) {
    if (isRoute(state)) state.feature.nodeRefs.forEach((ref, i) => add(routesAt, ref, { state, k: state.feature.nodeIndex[i], end: i === 0 || i === state.feature.nodeRefs.length - 1 }));
    else if (isBarrierWay(state)) state.feature.nodeRefs.forEach((ref, i) => add(waysAt, ref, { state, k: state.feature.nodeIndex[i] }));
    else if (isBarrierNode(state)) nodes.set(state.feature.osmId, state);
  }
  const reporter = (state) => (code, message, reason, key = "barrier") => issues.push({ key: `${code}:${state.feature.id}:${key}`, code, category: "uncertain", status: "informacja", severity: 1, confidence: "wysoka", message, reason, objects: [state.feature.id], location: state.feature.point ?? [state.feature.points[0], state.feature.points[1], state.feature.points[2] ?? 0], suggest: [{ key, reason: "Uściślenie tagu poprawia model bariery.", doc: `https://wiki.openstreetmap.org/wiki/Key:${key}` }] });
  const count = (height, known) => { stats[!height.approximate ? "tagHeight" : known ? "typeHeight" : "defaultHeight"] += 1; };

  const nodePlans = new Map();
  for (const [ref, state] of nodes) {
    const tags = state.tagsNow, report = reporter(state), { spec, known, heightSource, label } = specOf(cfg.nodes, tags, cfg);
    const invalid = (message, key) => report("barrier-value", message, "Użyto wartości z profilu.", key);
    if (!known) report("barrier-type-unknown", `Profil nie opisuje barrier=${tags.barrier}.`, `Pokazano słupek o wysokości ${cfg.fallback.height} m.`);
    const routes = routesAt.get(ref) ?? [], ways = waysAt.get(ref) ?? [], height = dimension(tags, "height", spec.height, heightSource, invalid);
    let width = null;
    for (const key of OPENING_WIDTH_KEYS) if (!width && tags[key] !== undefined) { const value = parseLength(tags[key]); if (value > 0) width = { value, source: `tag ${key}`, approximate: false }; else invalid(`Nieprawidłowa wartość ${key}=${tags[key]}.`, key); }
    if (!width && routes.length) width = { value: Math.max(...routes.map((r) => widthOf(r.state))), source: "szerokość trasy przechodzącej przez węzeł", approximate: true };
    if (!width) width = { value: spec.width, source: `założenie profilu dla barrier=${tags.barrier}`, approximate: true };
    // Rodzaj bramy i szlabanu (profile.furniture.gates): przesuwna z gate:type albo barrier=sliding_gate, skrzydłowa
    // z dwoma skrzydłami na trasie dla pojazdów albo przy szerokim otworze; szlaban z <barrier>:type single/double.
    const gates = model.profile.furniture?.gates;
    let motion = null, leaves = 1, kind = null, look = null;
    if (gates && spec.shape === "gate" && spec.opens) {
      const sliding = gates.slidingBarriers.includes(tags.barrier) || gates.slidingTypes.includes(tags["gate:type"]);
      const vehicle = routes.some((r) => gates.vehicleGroups.includes(r.state.interp.classDef.group));
      motion = sliding ? "sliding" : "swing";
      // Szerokość decyduje tylko wtedy, gdy pochodzi z tagu albo z trasy; domyślna szerokość typu jest założeniem.
      const measured = !width.source.startsWith("założenie profilu"), wide = measured && width.value >= gates.doubleLeafMinWidth;
      leaves = !sliding && gates.doubleLeafBarriers.includes(tags.barrier) && (vehicle || wide) ? 2 : 1;
      const basis = tags["gate:type"] ? `tag gate:type=${tags["gate:type"]}` : sliding ? `tag barrier=${tags.barrier}` : !gates.doubleLeafBarriers.includes(tags.barrier) ? `typ barrier=${tags.barrier}: jedno skrzydło` : vehicle ? "trasa dla pojazdów przez bramę (założenie profilu)" : wide ? `szerokość ${width.value} m, ${width.source} (założenie profilu)` : "brak typu: jedno skrzydło (założenie profilu)";
      kind = { value: `${sliding ? "przesuwna" : leaves === 2 ? "skrzydłowa, dwa skrzydła" : "skrzydłowa, jedno skrzydło"}`, source: basis, approximate: !tags["gate:type"] && !sliding };
      look = gates.materials[tags.material] ?? null;
    } else if (spec.shape === "boom") {
      leaves = tags[`${tags.barrier}:type`] === "double" ? 2 : 1;
      kind = { value: leaves === 2 ? "dwa ramiona" : "jedno ramię", source: tags[`${tags.barrier}:type`] ? `tag ${tags.barrier}:type` : "brak typu: jedno ramię", approximate: !tags[`${tags.barrier}:type`] };
    }
    let direction = null;
    if (ways.length) direction = tangentAt(ways[0].state.feature.points, ways[0].k);
    else if (routes.length) { const [tx, ty] = tangentAt(routes[0].state.feature.points, routes[0].k); direction = [-ty, tx]; }
    const route = routes[0], plan = {
      id: state.feature.id, kind: "node", type: tags.barrier, label, shape: spec.shape, pattern: look?.pattern ?? spec.pattern, color: look?.color ?? spec.color, accent: look?.color ?? spec.accent, opens: Boolean(spec.opens), thickness: spec.thickness, motion, leaves,
      height: height.value, width: width.value, direction, x: state.feature.point[0], y: state.feature.point[1], baseZ: route?.state.level?.z?.[route.k] ?? null, wayIds: ways.map((w) => w.state.feature.id),
      provenance: { type: { value: label, source: `tag barrier=${tags.barrier}`, approximate: !known }, height: { ...height }, width: { ...width }, ...(kind ? { kind } : {}) },
    };
    byId.set(plan.id, plan); nodePlans.set(ref, plan); count(height, known); stats.nodes += 1; stats.types[tags.barrier] = (stats.types[tags.barrier] ?? 0) + 1;
  }

  for (const state of model.states.values()) {
    if (!isBarrierWay(state)) continue;
    const tags = state.tagsNow, report = reporter(state), { spec, known, heightSource, label } = specOf(cfg.types, tags, cfg), { feature } = state, along = buildAlong(feature.points), length = along[along.length - 1];
    const invalid = (message, key) => report("barrier-value", message, "Użyto wartości z profilu.", key);
    if (!known) report("barrier-type-unknown", `Profil nie opisuje barrier=${tags.barrier}.`, `Przyjęto wysokość ${cfg.fallback.height} m.`);
    const height = dimension(tags, "height", spec.height, heightSource, invalid), thickness = dimension(tags, "width", spec.thickness, known ? `założenie profilu dla barrier=${tags.barrier}` : "typ nieokreślony w profilu: wartość domyślna", invalid);
    const cuts = [], passages = [];
    feature.nodeRefs.forEach((ref, i) => {
      const node = nodePlans.get(ref), routes = routesAt.get(ref) ?? [], s = along[feature.nodeIndex[i]];
      // Trasa bez znacznika musi przez barierę przechodzić: kończąca się przy niej nic o przejściu nie mówi. Liczą się tylko
      // trasy na poziomie bariery: jezdnia wchodząca w węźle na most (przyczółek przy ścianie oporowej) albo w tunel
      // przechodzi nad lub pod barierą, a nie przez nią.
      const level = routes.filter((r) => orderOf(r.state.tagsNow) === orderOf(tags));
      const passes = level.some((r) => !r.end) || level.length > 1;
      let width = null, source = null;
      if (node && (node.opens || routes.length)) { width = node.width; source = `barrier=${node.type}`; }
      else if (!node && passes) {
        width = Math.max(...level.map((r) => widthOf(r.state))); source = "trasa przechodzi przez węzeł bez tagu przejścia";
        stats.untaggedPassages += 1;
        report("barrier-passage-untagged", "Trasa przechodzi przez barierę w węźle bez tagu bramy lub przejścia.", "Pokazano otwór o szerokości trasy, bez bramy.", `barrier:${ref}`);
      }
      if (width === null) return;
      cuts.push([s - width / 2, s + width / 2]); passages.push({ s, width, source, node: node?.id ?? null });
    });
    cuts.sort((a, b) => a[0] - b[0]);
    const spans = [];
    let cursor = 0;
    for (const [from, to] of cuts) { if (from - cursor >= MIN_WALL_METERS) spans.push([cursor, Math.min(from, length)]); cursor = Math.max(cursor, to); }
    if (length - cursor >= MIN_WALL_METERS) spans.push([cursor, length]);
    const layer = Number(tags.layer ?? 0), onStructure = layer > 0 || (tags.bridge !== undefined && tags.bridge !== "no");
    // Jak most drogowy: nad trasą przechodzącą pod barierą (niższy poziom, bez wspólnego węzła; dla bariery na konstrukcji
    // także trasa bez poziomu) bariera nie schodzi w zagłębienie terenu nad tą trasą.
    const level = onStructure ? Math.max(orderOf(tags), 1) : orderOf(tags);
    // Miejsca (s wzdłuż bariery), w których trasa niższego poziomu przechodzi pod barierą.
    const over = (crossingsOf.get(feature.id) ?? []).filter(({ id }) => { const other = model.states.get(id); return other && isRoute(other) && orderOf(other.tagsNow) < level; })
      .map(({ id, x, y }) => ({ id, s: stationOf(feature.points, along, x, y) }));
    // Ściana oporowa: lico od terenu po niższej stronie (w OSM po prawej względem kierunku linii) do terenu po wyższej.
    // Wysokość wynika z terenu; tag height albo profil są używane tylko, gdy teren nie pokazuje uskoku.
    const retaining = tags.barrier === "retaining_wall";
    const heightProvenance = retaining
      ? { value: "od terenu po niższej stronie do terenu po wyższej", source: `teren (NMT) ${RETAINING_PROBE_METERS.join(", ")} m po obu stronach linii: najniższy po niższej, najwyższy po wyższej stronie; niższa strona po prawej względem kierunku linii (konwencja OSM). Gdy teren nie pokazuje uskoku: ${height.value} m (${height.source})`, approximate: true }
      : { ...height };
    const plan = {
      id: feature.id, kind: "way", type: tags.barrier, label, pattern: spec.pattern, retaining, color: spec.color, accent: spec.accent, solidTop: Boolean(spec.solidTop), height: height.value, thickness: thickness.value,
      along, length, spans, passages, onStructure, layer, over,
      provenance: { type: { value: label, source: `tag barrier=${tags.barrier}`, approximate: !known }, height: heightProvenance, thickness: { ...thickness } },
    };
    byId.set(plan.id, plan); count(height, known); stats.ways += 1; stats.openings += passages.length; stats.types[tags.barrier] = (stats.types[tags.barrier] ?? 0) + 1;
  }
  return { byId, issues, stats };
}
