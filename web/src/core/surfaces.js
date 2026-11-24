// Nawierzchnia, linia przebiegu i oznakowanie poziome wyprowadzone z tagów i profilu kraju.
// Moduł nie zna Polski: wszystkie wartości krajowe pochodzą z profilu. Oznakowanie powstaje tylko z istniejących tagów.

import { applyConnectivity } from "./connectivity.js";
import { finishSteps } from "./diagnostics.js";

const AXIS_TAPER_METERS = 30;
// Rozwidlenie: gałęzie odchodzą w tę samą stronę (kąt do 60°), a pień ma ich łączną liczbę pasów i szerokość (±15%) albo jest odcinkiem przejściowym.
const FORK_COS = 0.5, FORK_WIDTH_TOLERANCE = 0.15;
// Rozsunięcie gałęzi wygasa najpóźniej na 10 m przed drugim końcem wayu.
const FORK_FAR_END_METERS = 10;
// Linia krawędziowa: próbkowanie co 0,5 m; inna jezdnia tego samego poziomu (do 1,5 m różnicy) przerywa linię; kawałki krótsze niż 1 m są pomijane.
// Jezdnie biegnące w węźle prawie na wprost (do ok. 37°) są kontynuacją także przy trzeciej jezdni w węźle.
// Liczba jezdni z linią krawędziową liczonych w jednym etapie przy doczytywaniu kafli.
const EDGE_BATCH = 400;
const EDGE_STEP_METERS = 0.5, EDGE_LEVEL_METERS = 1.5, EDGE_CELL_METERS = 25, EDGE_MIN_PIECE_METERS = 1, EDGE_STRAIGHT_COS = -0.8, EDGE_BISECT_STEPS = 12;
const SPAN_CELL_METERS = 25, SPAN_STEP_METERS = 0.25, SPAN_MIN_METERS = 1, SPAN_LEVEL_METERS = 1.5, SPAN_NODE_MARGIN_METERS = 1;
const MIN_DASH_METERS = 0.8, CROSSING_PARTS_GAP_METERS = 0.3, NODE_DUPLICATE_METERS = 3;
const ONEWAY_FORWARD = new Set(["yes", "true", "1"]);
const CROSSING_KEYS = ["footway", "cycleway", "path"];

const isCrossingWay = (tags, def) => !def.stairs && CROSSING_KEYS.some((key) => tags[key] === "crossing");

/** Dla kogo jest obiekt przejścia; rozstrzygają wyłącznie jego tagi. */
function crossingObject(tags) {
  const cycle = tags.cycleway === "crossing" || tags.highway === "cycleway" || tags.bicycle === "designated";
  return {
    foot: tags.footway === "crossing" || (tags.path === "crossing" && tags.foot !== "no") || tags.foot === "designated",
    cycle,
    // Ogólne „oznakowane” opisuje główne przeznaczenie wayu: samo foot=designated na drodze rowerowej nie tworzy zebry.
    markedFoot: tags.footway === "crossing" || (tags.path === "crossing" && tags.foot !== "no" && tags.cycleway !== "crossing" && tags.bicycle !== "designated"),
    markedCycle: cycle,
  };
}

/** Rodzaje malowania opisane tagiem; znaczenie wartości podaje profil kraju. */
function crossingParts(tags, cfg, object) {
  const key = tags["crossing:markings"] !== undefined ? "crossing:markings" : tags.crossing !== undefined ? "crossing" : null;
  if (!key) return [];
  return tags[key].split(";").map((value) => value.trim()).flatMap((value) => {
    const entry = cfg.crossingMarkings[value];
    if (!entry) return [];
    const base = { value, source: key };
    if (!entry.generic) return [{ ...entry, ...base }];
    // Oznakowany obiekt pieszy i rowerowy mają różne wzory, określone w profilu kraju.
    const parts = [];
    if (object.markedFoot) parts.push({ pattern: entry.pattern, applies: "foot", label: entry.label, generic: true, ...base });
    if (object.markedCycle && entry.cycle) parts.push({ ...entry.cycle, applies: "cycle", generic: true, ...base });
    return parts;
  });
}

/** Układ malowania w poprzek kierunku przejścia; dwa rodzaje leżą obok siebie. */
function layoutParts(parts, cfg) {
  const widthOf = (part) => (part.applies === "cycle" ? cfg.cycleCrossingWidthMeters : cfg.crossingWidthMeters);
  const total = parts.reduce((sum, part) => sum + widthOf(part), 0) + CROSSING_PARTS_GAP_METERS * (parts.length - 1);
  let edge = -total / 2;
  const items = parts.map((part) => {
    const half = widthOf(part) / 2, offset = edge + half;
    edge += half * 2 + CROSSING_PARTS_GAP_METERS;
    return { ...part, half, offset };
  });
  return { items, extent: total / 2 };
}

function setCrossing(plan, parts, cfg, origin) {
  const { items, extent } = layoutParts(parts, cfg);
  plan.crossing = { parts: items, extent, spans: [], object: plan.crossingObject };
  plan.provenance.crossing = {
    value: items.map((part) => part.label).join(" + "),
    source: items.map((part) => `${origin}tag ${part.source}=${part.value}`).join(", "),
    approximate: items.some((part) => part.approximate) || items.length > 1,
  };
}

function buildAlong(points) {
  const along = [0];
  for (let i = 3; i < points.length; i += 3) along.push(along[along.length - 1] + Math.hypot(points[i] - points[i - 3], points[i + 1] - points[i - 2]));
  return along;
}

const PLACEMENT_KEYS = ["placement", "placement:forward", "placement:backward"];
const WIDTH_LANES_KEY = /^width:lanes(:forward|:backward)?(:start|:end)?$/;
// Strzałka nie mieści się na pasie węższym niż 1 m (np. pasie zanikającym przy width:lanes:end=||0).
const MIN_ARROW_LANE_METERS = 1;
const sum = (list) => list.reduce((t, v) => t + v, 0);
/** Krawędzie pasów od lewej: [0, w1, w1+w2, ...]. */
const edgesOf = (widths) => widths.reduce((edges, w) => { edges.push(edges[edges.length - 1] + w); return edges; }, [0]);
// Położenie wayu w pasie N, w pasach od lewej krawędzi jezdni.
const PLACEMENT_SIDE = { left_of: (lane) => lane - 1, middle_of: (lane) => lane - 0.5, right_of: (lane) => lane };

function directionOf(tags) {
  if (ONEWAY_FORWARD.has(tags.oneway)) return 1;
  if (tags.oneway === "-1" || tags.oneway === "reverse") return -1;
  return 0;
}

function mergeZones(zones) {
  const merged = [];
  for (const zone of [...zones].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && zone[0] <= last[1]) last[1] = Math.max(last[1], zone[1]);
    else merged.push([...zone]);
  }
  return merged;
}

const parseTurns = (raw) => raw.split("|").map((lane) => lane.split(";").map((v) => v.trim()).filter((v) => v && v !== "none"));
const positiveInt = (raw) => (/^\d+$/.test(raw ?? "") ? Number(raw) : null);

export function planWaySurface(state, profile) {
  const cfg = profile.surfaces, { feature, interp, tagsNow: tags } = state, def = interp.classDef, issues = [];
  const issue = (code, severity, message, reason, suggest = []) => issues.push({ key: `${code}:${feature.id}`, code, category: "uncertain", status: "informacja", severity, confidence: "wysoka", message, reason, objects: [feature.id], location: [feature.points[0], feature.points[1], feature.points[2] ?? 0], suggest });
  const doc = (key, reason) => ({ key, reason, doc: `https://wiki.openstreetmap.org/wiki/Key:${key}` });
  const along = buildAlong(feature.points), length = along[along.length - 1];
  const plan = { id: feature.id, surfaced: Boolean(def.surfaced), along, length, axis: feature.points, centerOffset: 0, dividers: [], arrows: [], crossing: null, crossingObject: null, line: null, clearZones: [], coreZones: [], crossZones: [], lineZones: [], issues, provenance: {} };
  // Linia przebiegu jest schematem niezależnym od nawierzchni: mają ją też cieki, które nawierzchni nie mają.
  if (def.routeLine) {
    const width = interp.dimensions.width?.value ?? def.widthMeters ?? 2;
    plan.line = { group: def.routeLine, color: def.lineColor ?? def.color, half: Math.min(cfg.routeLineMaxWidthMeters, Math.max(cfg.routeLineMinWidthMeters, width * cfg.routeLineWidthRatio)) / 2, minPx: cfg.routeLineMinPixels };
  }
  if (!def.surfaced) {
    plan.materialId = null;
    plan.material = { label: def.label, color: def.color, accent: def.casing ?? def.color, pattern: "solid" };
    return plan;
  }

  const surface = tags.surface, mapped = surface === undefined ? undefined : cfg.surfaceMaterials[surface];
  plan.materialId = mapped ?? cfg.defaultMaterial;
  plan.material = cfg.materials[plan.materialId];
  plan.provenance.surface = { value: plan.material.label, source: mapped ? `tag surface=${surface}` : surface ? `nieznane surface=${surface}` : "brak tagu surface: materiał neutralny", approximate: !mapped };
  if (surface !== undefined && !mapped) issue("surface-unknown", 1, `Profil nie ma materiału dla surface=${surface}.`, "Użyto neutralnego materiału; wartość tagu pozostaje bez zmian.", [doc("surface", "Rodzaj nawierzchni.")]);
  if (isCrossingWay(tags, def)) {
    plan.crossingObject = crossingObject(tags);
    const parts = crossingParts(tags, cfg, plan.crossingObject);
    if (parts.length) setCrossing(plan, parts, cfg, "");
  }
  if (!def.carriageway) return plan;

  // placement=transition (także w wariancie kierunkowym): odcinek łączy krawędzie sąsiednich odcinków; nie wymaga liczby pasów.
  const transitionKey = PLACEMENT_KEYS.find((key) => tags[key] === "transition");
  if (transitionKey) {
    plan.transition = true;
    plan.provenance.placement = { value: "odcinek przejściowy: łączy krawędzie sąsiednich odcinków", source: `tag ${transitionKey}=transition`, approximate: false };
  }

  const lanes = interp.attributes.lanes, width = interp.dimensions.width?.value ?? def.widthMeters;
  plan.width = width;
  if (!lanes) { plan.provenance.lanes = { value: "brak", source: "brak tagu lanes: bez linii pasów", approximate: false }; return plan; }
  const laneWidth = width / lanes, direction = directionOf(tags), painted = tags.lane_markings;
  plan.laneWidth = laneWidth; plan.lanes = lanes; plan.direction = direction;
  plan.provenance.lanes = { value: lanes, source: "tag lanes", approximate: false };
  plan.provenance.laneWidth = { value: Number(laneWidth.toFixed(2)), source: interp.dimensions.width?.source ?? "szerokość klasy", approximate: interp.dimensions.width?.approximate ?? true };

  let forward = positiveInt(tags["lanes:forward"]), backward = positiveInt(tags["lanes:backward"]);
  if (!direction) {
    if (forward === null && backward !== null) forward = lanes - backward;
    if (backward === null && forward !== null) backward = lanes - forward;
    if (forward === null && lanes % 2 === 0) { forward = lanes / 2; backward = lanes / 2; }
    if (forward !== null && backward !== null && forward + backward !== lanes && tags["lanes:both_ways"] === undefined) issue("lanes-split", 1, `lanes=${lanes} nie zgadza się z lanes:forward=${forward} i lanes:backward=${backward}.`, "Podział kierunków nie jest używany do strzałek.", [doc("lanes", "Liczba pasów.")]);
  }
  plan.lanesForward = forward; plan.lanesBackward = backward;
  // Pasy są liczone od lewej strony patrząc zgodnie z kierunkiem wayu.
  const forwardOnRight = cfg.drivingSide === "right";

  // width:lanes (Key:*:lanes): szerokości pasów w metrach, od lewej patrząc w kierunku jazdy tych pasów; puste pole to szerokość domyślna.
  // :start i :end (Proposal:Suffix start and end, użyte w przykładach Proposal:Placement) podają szerokości na początku i końcu wayu;
  // między nimi szerokość zmienia się liniowo, a pas o szerokości 0 zaczyna się lub kończy na tym końcu. Wynik jest w układzie wayu (od lewej).
  let wayWidths = { start: Array(lanes).fill(laneWidth), end: Array(lanes).fill(laneWidth) };
  const widthKeys = Object.keys(tags).filter((k) => WIDTH_LANES_KEY.test(k));
  if (widthKeys.length) {
    const reported = new Set();
    const widthsIssue = (code, message, reason) => { if (reported.has(message)) return; reported.add(message); issue(code, 1, message, `${reason} Szerokość pasów pozostaje domyślna.`, [doc("width:lanes", "Szerokość poszczególnych pasów.")]); };
    let valid = true;
    const parse = (key) => {
      if (tags[key] === undefined) return undefined;
      const list = tags[key].split("|").map((field) => { const v = field.trim().replace(/\s*m$/, ""); return v === "" ? null : /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN; });
      if (list.some(Number.isNaN)) { widthsIssue("width-lanes-value", `Nie można odczytać ${key}=${tags[key]}.`, "Pola muszą być liczbą metrów albo puste."); valid = false; return undefined; }
      return list;
    };
    // Szerokości jednego zestawu pasów (np. width:lanes:forward) na końcu „start” lub „end”, w kolejności od lewej w kierunku jazdy.
    const listFor = (base, count, end) => {
      const own = parse(`${base}:${end}`), plain = parse(base);
      for (const [key, list] of [[`${base}:${end}`, own], [base, plain]]) {
        if (list && list.length !== count) { widthsIssue("width-lanes-count", `${key} opisuje ${list.length} pasów, a jest ich ${count}.`, "Szerokości nie przypisano, aby nie trafiły do złych pasów."); valid = false; }
      }
      return Array.from({ length: count }, (_, i) => own?.[i] ?? plain?.[i] ?? laneWidth);
    };
    const hasDirectional = widthKeys.some((k) => /:forward|:backward/.test(k));
    const assemble = (end) => {
      if (direction) {
        // Jezdnia jednokierunkowa: pasy podaje się w kierunku ruchu; wariant zgodny z kierunkiem ruchu oznacza wszystkie pasy.
        const base = widthKeys.some((k) => /^width:lanes(:start|:end)?$/.test(k)) ? "width:lanes" : `width:lanes:${direction === 1 ? "forward" : "backward"}`;
        const list = listFor(base, lanes, end);
        return direction === 1 ? list : list.reverse();
      }
      if (!hasDirectional) return listFor("width:lanes", lanes, end);
      if (forward === null || backward === null || forward + backward !== lanes) { widthsIssue("width-lanes-split", "width:lanes:forward/backward wymaga podziału pasów na kierunki (lanes:forward, lanes:backward).", "Nie wiadomo, gdzie leżą pasy każdego kierunku."); valid = false; return null; }
      const f = listFor("width:lanes:forward", forward, end), b = listFor("width:lanes:backward", backward, end).reverse();
      return forwardOnRight ? [...b, ...f] : [...f, ...b];
    };
    const start = assemble("start"), end = assemble("end");
    if (valid && start && end) {
      wayWidths = { start, end };
      plan.laneWidths = wayWidths;
      plan.widthStart = sum(start); plan.widthEnd = sum(end);
      const same = Math.abs(plan.widthStart - plan.widthEnd) < 0.01;
      plan.provenance.width = { value: same ? `${plan.widthStart.toFixed(2)} m` : `od ${plan.widthStart.toFixed(2)} m na początku do ${plan.widthEnd.toFixed(2)} m na końcu`, source: `tag ${widthKeys.sort().map((k) => `${k}=${tags[k]}`).join(", ")}${widthKeys.every((k) => !tags[k].split("|").some((f) => f.trim() === "")) ? "" : `; puste pola: ${laneWidth.toFixed(2)} m`}`, approximate: widthKeys.some((k) => tags[k].split("|").some((f) => f.trim() === "")) };
    }
  }
  const laneCentre = (index) => -width / 2 + (index + 0.5) * laneWidth;

  // placement (Proposal:Placement): pasy liczone od lewej patrząc w kierunku wayu, pas 1 skrajnie z lewej.
  // Na drodze dwukierunkowej wariant :forward lub :backward liczy tylko pasy danego kierunku, patrząc w tym kierunku.
  // Wynik to odległość wayu od lewej krawędzi jezdni (patrząc zgodnie z wayem).
  const placementIssue = (key, value, reason) => issue("placement-value", 1, `Nie można zastosować ${key}=${value}.`, `${reason} Jezdnia w tym miejscu pozostaje wyśrodkowana na wayu.`, [doc("placement", "Położenie wayu względem pasów.")]);
  const fromLeftOf = (key, value, widths) => {
    const match = /^(left_of|middle_of|right_of):(\d+)$/.exec(value ?? "");
    if (!match) { placementIssue(key, value, "Wartość musi mieć postać left_of:N, middle_of:N, right_of:N lub transition."); return null; }
    const lane = Number(match[2]), side = key.includes(":forward") ? "forward" : key.includes(":backward") ? "backward" : null, total = sum(widths);
    // Położenie w zestawie pasów oglądanym w jego kierunku jazdy, z rzeczywistych szerokości pasów (width:lanes).
    const viewAt = (view) => { const e = edgesOf(view); return match[1] === "left_of" ? e[lane - 1] : match[1] === "right_of" ? e[lane] : (e[lane - 1] + e[lane]) / 2; };
    if (!side || direction) {
      if (!direction) { issue("placement-two-way", 1, `${key} na drodze dwukierunkowej wymaga wariantu :forward lub :backward.`, "Jezdnia pozostaje wyśrodkowana na wayu.", [doc("placement", "Położenie wayu względem pasów.")]); return null; }
      // Na jezdni jednokierunkowej wariant zgodny z kierunkiem ruchu oznacza wszystkie pasy.
      if (side && (side === "forward") !== (direction === 1)) { placementIssue(key, value, "Na jezdni jednokierunkowej nie ma pasów w tym kierunku."); return null; }
      if (lane < 1 || lane > lanes) { placementIssue(key, value, `Jezdnia ma ${lanes} pasy.`); return null; }
      // Kierunek wayu przeciwny do ruchu (oneway=-1) nie zmienia numeracji: pasy liczy się patrząc zgodnie z wayem.
      return side === "backward" ? total - viewAt([...widths].reverse()) : viewAt(widths);
    }
    if (forward === null || backward === null) { placementIssue(key, value, "Nie wiadomo, ile pasów ma każdy kierunek (lanes:forward, lanes:backward)."); return null; }
    const count = side === "forward" ? forward : backward;
    if (lane < 1 || lane > count) { placementIssue(key, value, `Kierunek ma ${count} pasy.`); return null; }
    // Ruch prawostronny: pasy przeciwne leżą z lewej strony wayu, a numeracja każdego kierunku zaczyna się przy osi jezdni.
    const middle = edgesOf(widths)[forwardOnRight ? backward : forward];
    if (forwardOnRight) return side === "forward" ? middle + viewAt(widths.slice(backward)) : middle - viewAt(widths.slice(0, backward).reverse());
    return side === "forward" ? viewAt(widths.slice(0, forward)) : total - viewAt(widths.slice(forward).reverse());
  };
  const placedKeys = PLACEMENT_KEYS.filter((key) => [key, `${key}:start`, `${key}:end`].some((k) => tags[k] !== undefined && tags[k] !== "transition"));
  if (placedKeys.length && !plan.transition) {
    const solve = (key) => {
      const start = fromLeftOf(`${tags[`${key}:start`] !== undefined ? `${key}:start` : key}`, tags[`${key}:start`] ?? tags[key], wayWidths.start);
      const end = fromLeftOf(`${tags[`${key}:end`] !== undefined ? `${key}:end` : key}`, tags[`${key}:end`] ?? tags[key], wayWidths.end);
      return start === null || end === null ? null : { key, start, end };
    };
    const solved = placedKeys.map(solve).filter(Boolean);
    if (solved.length > 1 && solved.some((s) => Math.abs(s.start - solved[0].start) > 0.05 || Math.abs(s.end - solved[0].end) > 0.05)) issue("placement-conflict", 1, `Tagi ${solved.map((s) => s.key).join(" i ")} wskazują różne położenie wayu.`, `Użyto ${solved[0].key}.`, [doc("placement", "Położenie wayu względem pasów.")]);
    const chosen = solved[0];
    if (chosen) {
      plan.offsetStart = sum(wayWidths.start) / 2 - chosen.start; plan.offsetEnd = sum(wayWidths.end) / 2 - chosen.end;
      plan.centerOffset = (plan.offsetStart + plan.offsetEnd) / 2;
      const describe = (offset) => `${offset >= 0 ? "w prawo" : "w lewo"} o ${Math.abs(offset).toFixed(1)} m`;
      const keys = [chosen.key, `${chosen.key}:start`, `${chosen.key}:end`].filter((k) => tags[k] !== undefined).map((k) => `${k}=${tags[k]}`).join(", ");
      plan.provenance.placement = { value: Math.abs(plan.offsetStart - plan.offsetEnd) < 0.01 ? `oś jezdni ${describe(plan.offsetStart)} od wayu` : `oś jezdni od ${describe(plan.offsetStart)} na początku do ${describe(plan.offsetEnd)} na końcu`, source: `tag ${keys}`, approximate: Boolean(interp.dimensions.width?.approximate) };
    }
  }
  // Oznakowanie poziome jest malowane tylko na nawierzchni utwardzonej, na której da się je wykonać (flaga markable w profilu).
  if (plan.material?.markable === false) {
    plan.provenance.markings = { value: "brak", source: `nawierzchnia „${plan.material.label}” (tag surface=${tags.surface}): bez malowanych linii`, approximate: false };
    return plan;
  }
  if (painted === "no") {
    plan.provenance.markings = { value: "brak", source: "tag lane_markings=no", approximate: false };
    return plan;
  }
  const confirmed = painted === "yes";
  // Linia krawędziowa towarzyszy oznakowaniu pasów; jej przebieg i przerwy liczy applyEdgeLines.
  plan.edgeLine = { confirmed, sides: [] };
  // Bez tagu surface nawierzchnia jest nieznana: linie są rysowane, ale jako przybliżenie.
  const surfaceUnknown = tags.surface === undefined;
  plan.provenance.markings = { value: confirmed ? "pasy oznakowane" : "układ pasów", source: `${confirmed ? "tag lane_markings=yes" : "tag lanes; malowanie i rodzaj linii niepotwierdzone"}; linie krawędziowe${surfaceUnknown ? "; brak tagu surface: nawierzchnia utwardzona nie jest potwierdzona" : ""}`, approximate: !confirmed || surfaceUnknown };
  // Na odcinku przejściowym położenie linii zależy od szerokości w danym miejscu (laneOffset), znanej dopiero po ustaleniu sąsiadów.
  if (plan.transition) plan.provenance.markings = { value: "pasy na odcinku przejściowym", source: `tag lanes=${lanes}; pasy mają szerokość ${laneWidth.toFixed(2)} m, a zmianę szerokości przejmuje skrajny pas po stronie ${cfg.drivingSide === "right" ? "prawej" : "lewej"} (założenie)`, approximate: true };
  if (plan.laneWidths) plan.provenance.markings = { ...plan.provenance.markings, source: `${plan.provenance.markings.source}; położenie linii z width:lanes` };
  const startEdges = edgesOf(wayWidths.start), startWidth = sum(wayWidths.start);
  for (let k = 1; k < lanes; k += 1) plan.dividers.push({ offset: startEdges[k] - startWidth / 2, lane: k, confirmed, dashes: [] });

  const addTurns = (raw, key, laneIndexes, travel) => {
    const turns = parseTurns(raw);
    if (turns.length !== laneIndexes.length) {
      issue("turn-lanes-count", 1, `${key} opisuje ${turns.length} pasów, a jezdnia ma ich ${laneIndexes.length}.`, "Strzałek nie narysowano, aby nie przypisać ich do złych pasów.", [doc("turn", "Kierunki na pasach.")]);
      return;
    }
    const margin = Math.min(cfg.arrowDistanceMeters, length * 0.35), s = travel > 0 ? length - margin : margin;
    turns.forEach((values, i) => {
      if (!values.length || length < cfg.arrowMinWayMeters) return;
      // Pas zwężony do zera (width:lanes) nie mieści strzałki w tym miejscu.
      if (plan.laneWidths) { const f = s / length, k = laneIndexes[i], w = wayWidths.start[k] + (wayWidths.end[k] - wayWidths.start[k]) * f; if (w < MIN_ARROW_LANE_METERS) return; }
      plan.arrows.push({ offset: laneCentre(laneIndexes[i]), lane: laneIndexes[i], travel, s, turns: values, source: key });
    });
  };
  const range = (from, count) => Array.from({ length: count }, (_, i) => from + i);
  if (direction && tags["turn:lanes"]) addTurns(tags["turn:lanes"], "turn:lanes", direction > 0 ? range(0, lanes) : range(0, lanes).reverse(), direction);
  if (!direction && forward !== null && backward !== null && forward + backward === lanes) {
    const forwardLanes = forwardOnRight ? range(backward, forward) : range(0, forward).reverse();
    const backwardLanes = forwardOnRight ? range(0, backward).reverse() : range(forward, backward);
    if (tags["turn:lanes:forward"]) addTurns(tags["turn:lanes:forward"], "turn:lanes:forward", forwardLanes, 1);
    if (tags["turn:lanes:backward"]) addTurns(tags["turn:lanes:backward"], "turn:lanes:backward", backwardLanes, -1);
  }
  settleMarkings(plan, cfg);
  return plan;
}

/** Kreski i strzałki omijają obszar przejść: kreski są przycinane, a strzałki cofane przed przejście. */
function settleMarkings(plan, cfg) {
  const zones = mergeZones(plan.clearZones), { length } = plan, clear = Math.min(cfg.junctionClearMeters, length * 0.2);
  const hit = (from, to) => zones.find((zone) => to > zone[0] && from < zone[1]);
  // Na styku z kontynuacją jezdni linie biegną do węzła; odstęp zostaje tylko przy skrzyżowaniu i na wolnym końcu.
  const open = { start: Boolean(plan.continuous?.start), end: Boolean(plan.continuous?.end) };
  const lo = open.start ? 0 : clear, hi = length - (open.end ? 0 : clear), period = cfg.dashMeters + cfg.gapMeters;
  // Rytm kresek w układzie całego ciągu jezdni (applyLaneContinuity), aby kreska przechodziła przez węzeł bez przesunięcia.
  const chain = plan.dashChain ?? { from: -lo, reversed: false };
  const toChain = (s) => (chain.reversed ? chain.from + length - s : chain.from + s);
  const c0 = Math.min(toChain(lo), toChain(hi)), c1 = Math.max(toChain(lo), toChain(hi));
  for (const divider of plan.dividers) {
    divider.dashes = [];
    if (hi <= lo) continue;
    for (let k = Math.floor(c0 / period); k * period < c1; k += 1) {
      const a = Math.max(k * period, c0), b = Math.min(k * period + cfg.dashMeters, c1);
      if (b - a <= 0.01) continue;
      const s0 = chain.reversed ? chain.from + length - b : a - chain.from;
      let pieces = [[s0, s0 + (b - a)]];
      for (const zone of zones) pieces = pieces.flatMap(([x, y]) => (y <= zone[0] || x >= zone[1] ? [[x, y]] : [[x, Math.min(y, zone[0])], [Math.max(x, zone[1]), y]]));
      // Kreska przecięta węzłem jest dokończona na sąsiedniej jezdni, więc jej krótki fragment zostaje.
      const atNode = ([x, y]) => (open.start && x <= 1e-6) || (open.end && y >= length - 1e-6);
      divider.dashes.push(...pieces.filter((piece) => piece[1] - piece[0] >= MIN_DASH_METERS || (atNode(piece) && piece[1] - piece[0] > 0.05)));
    }
    divider.dashes.sort((x, y) => x[0] - y[0]);
  }
  const reach = cfg.arrowHalfLengthMeters * Math.min(1, (plan.laneWidth ?? cfg.laneWidthMeters) / cfg.laneWidthMeters);
  let moved = 0, omitted = 0;
  for (const travel of [1, -1]) {
    const group = plan.arrows.filter((arrow) => arrow.travel === travel);
    if (!group.length) continue;
    const original = group[0].originalS ?? group[0].s;
    let s = original, zone = hit(s - reach, s + reach), guard = 0;
    while (zone && guard < 20) { s = travel > 0 ? zone[0] - reach - 0.01 : zone[1] + reach + 0.01; zone = hit(s - reach, s + reach); guard += 1; }
    const shifted = s !== original;
    if (shifted && (s - reach < 0 || s + reach > length)) { omitted += group.length; for (const arrow of group) arrow.omitted = true; continue; }
    for (const arrow of group) { arrow.originalS = original; arrow.s = s; }
    if (shifted) moved += group.length;
  }
  plan.arrows = plan.arrows.filter((arrow) => !arrow.omitted);
  if (plan.arrows.length || omitted) {
    const notes = [moved ? `${moved} cofnięto przed przejście` : "", omitted ? `${omitted} pominięto, bo nie mieszczą się poza przejściem` : ""].filter(Boolean).join(", ");
    plan.provenance.arrows = { value: plan.arrows.length, source: [...new Set(plan.arrows.map((a) => `tag ${a.source}`)), notes].filter(Boolean).join("; "), approximate: Boolean(moved || omitted) };
  }
}

/**
 * Oś jezdni z placement. Odcinek z placement:start i placement:end zmienia położenie liniowo wzdłuż wayu.
 * Odcinek placement=transition łączy krawędzie sąsiednich odcinków: oś (i szerokość przy rysowaniu) przechodzi liniowo
 * od sąsiada na początku do sąsiada na końcu, a sąsiedzi zachowują swoje położenie aż do węzła.
 * Bez odcinka przejściowego różne położenia na styku są wygładzane na krótkim odcinku, aby węzeł pozostał połączony.
 */
function applyAxes(model, plans, ends) {
  const offsetAt = (plan, atStart) => (atStart ? plan.offsetStart : plan.offsetEnd) ?? plan.centerOffset;
  const others = (ref, self) => (ends.get(ref) ?? []).filter((e) => e.plan !== self);
  const average = (list) => list.reduce((t, e) => t + offsetAt(e.plan, e.atStart), 0) / list.length;
  for (const plan of plans.values()) {
    const state = model.states.get(plan.id);
    if (!state.interp.classDef.carriageway) continue;
    const refs = state.feature.nodeRefs, ownStart = offsetAt(plan, true), ownEnd = offsetAt(plan, false);
    let start, end, taper;
    if (plan.transition) {
      const side = (ref) => { const list = others(ref, plan).filter((e) => !e.plan.transition); return list.length ? average(list) : 0; };
      start = side(refs[0]); end = side(refs[refs.length - 1]); taper = null;
    } else {
      const meet = (ref, own, atStart) => {
        // Gałąź rozwidlenia jest przesuwana wektorem wzdłuż normalnej pnia (niżej), a nie na średnią osi.
        if (plan.forks?.[atStart ? "start" : "end"] || plan.forkTotal?.[atStart ? "start" : "end"]) return own;
        const list = others(ref, plan);
        return !list.length || list.some((e) => e.plan.transition) ? own : (own + average(list) * list.length) / (list.length + 1);
      };
      start = meet(refs[0], ownStart, true); end = meet(refs[refs.length - 1], ownEnd, false); taper = Math.min(AXIS_TAPER_METERS, plan.length / 2) || 1;
    }
    const forkStart = taper !== null ? plan.forks?.start : null, forkEnd = taper !== null ? plan.forks?.end : null;
    if (!ownStart && !ownEnd && !start && !end && !forkStart && !forkEnd) continue;
    const { points } = state.feature, axis = points.slice(), n = points.length / 3;
    const spreadStart = forkStart && overlapShare(model, plan, forkStart, true), spreadEnd = forkEnd && overlapShare(model, plan, forkEnd, false);
    for (let i = 0; i < n; i += 1) {
      const p = Math.max(0, i - 1), q = Math.min(n - 1, i + 1);
      let tx = points[q * 3] - points[p * 3], ty = points[q * 3 + 1] - points[p * 3 + 1];
      const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      const s = plan.along[i], f = plan.length ? s / plan.length : 0;
      let offset, vx = 0, vy = 0;
      if (taper === null) offset = start + (end - start) * f;
      else {
        const fromStart = Math.max(0, 1 - s / taper), fromEnd = Math.max(0, 1 - (plan.length - s) / taper), base = ownStart + (ownEnd - ownStart) * f;
        offset = base + (start - ownStart) * fromStart + (end - ownEnd) * fromEnd;
        // W węźle rozwidlenia gałąź leży dokładnie na swoim miejscu w przekroju pnia, także gdy odchodzi pod dużym kątem.
        // Gałąź odsuwa się od sąsiedniej gałęzi tylko tak daleko, jak sięga ich nakładanie (overlapShare); bez sąsiada przez 30 m.
        const kStart = spreadStart ? spreadStart[i] : fromStart, kEnd = spreadEnd ? spreadEnd[i] : fromEnd;
        if (forkStart) { vx += forkStart.vx * kStart; vy += forkStart.vy * kStart; }
        if (forkEnd) { vx += forkEnd.vx * kEnd; vy += forkEnd.vy * kEnd; }
      }
      axis[i * 3] = points[i * 3] + ty * offset + vx; axis[i * 3 + 1] = points[i * 3 + 1] - tx * offset + vy;
    }
    plan.axis = axis;
  }
}

/**
 * Ciągłość linii pasów przez węzły: zwykły styk dwóch jezdni z pasami (bez innej jezdni w węźle) oraz rozwidlenie i złączenie.
 * Takie końce nie mają odstępu skrzyżowania, a rytm kresek jest liczony wzdłuż całego ciągu jezdni.
 */
function applyLaneContinuity(model, plans, ends, roadsAtNode) {
  const links = new Map(), link = (a, b) => { for (const [x, y] of [[a, b], [b, a]]) { if (!links.has(x.plan)) links.set(x.plan, []); links.get(x.plan).push({ self: x, other: y }); } };
  const mark = (e) => { (e.plan.continuous ??= {})[e.atStart ? "start" : "end"] = true; };
  for (const [ref, list] of ends) {
    const lined = list.filter((e) => e.plan.dividers.length);
    const through = new Set((roadsAtNode.get(ref) ?? []).map((s) => s.feature.id));
    if (list.length === 2 && through.size === 2 && lined.length === 2) { lined.forEach(mark); link(lined[0], lined[1]); continue; }
    for (const e of lined) {
      const key = e.atStart ? "start" : "end", trunkId = e.plan.forks?.[key]?.trunk;
      if (e.plan.forkTotal?.[key]) mark(e);
      const trunk = trunkId && list.find((x) => x.plan.id === trunkId);
      if (trunk) { mark(e); if (trunk.plan.dividers.length) link(e, trunk); }
    }
  }
  // Rytm kresek: współrzędna wzdłuż ciągu przechodzi przez węzeł bez skoku, także gdy sąsiednie waye mają przeciwny kierunek.
  for (const seed of links.keys()) {
    if (seed.dashChain) continue;
    seed.dashChain = { from: 0, reversed: false };
    const queue = [seed];
    while (queue.length) {
      const plan = queue.shift(), { from, reversed } = plan.dashChain, L = plan.length;
      for (const { self, other } of links.get(plan) ?? []) {
        if (other.plan.dashChain) continue;
        const node = reversed ? (self.atStart ? from + L : from) : (self.atStart ? from : from + L);
        const rising = reversed ? self.atStart : !self.atStart, M = other.plan.length;
        other.plan.dashChain = rising ? { from: node, reversed: !other.atStart } : { from: node - M, reversed: other.atStart };
        queue.push(other.plan);
      }
    }
  }
}

/** Odległość punktu od łamanej (m). */
/** Pierwszy odcinek osi (k ≥ 1), którego koniec leży nie bliżej niż s od początku; along rośnie, więc wyszukiwanie binarne. */
function segmentAt(along, s) {
  let lo = 1, hi = along.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (along[mid] < s) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Odległość punktu od zbioru odcinków {p, q} (pętla bez tablic pośrednich: wywoływana tysiące razy przy narożnikach). */
function distanceToPieces(near, x, y) {
  let best = Infinity;
  for (const { p: a, q: b } of near) {
    const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
    if (d < best) best = d;
  }
  return best;
}

function distanceToLine(points, x, y) {
  let best = Infinity;
  for (let i = 3; i < points.length; i += 3) {
    const ax = points[i - 3], ay = points[i - 2], dx = points[i] - ax, dy = points[i + 1] - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return best;
}

/**
 * Udział przesunięcia gałęzi rozwidlenia w kolejnych punktach wayu: 1 w węźle, gdzie gałęzie leżą w jednym miejscu,
 * potem 1 − odległość / wymagany odstęp do sąsiedniej gałęzi, aż gałęzie przestaną na siebie nachodzić; dalej 0.
 * Gałęzie biegnące obok siebie bliżej niż wynika z ich szerokości są więc rozsuwane dokładnie o brakujący odstęp.
 */
function overlapShare(model, plan, fork, atStart) {
  if (!fork.neighbours?.length) return null;
  const points = model.states.get(plan.id).feature.points, n = points.length / 3, share = new Float64Array(n);
  const others = fork.neighbours.map((nb) => ({ points: model.states.get(nb.id)?.feature.points, need: (fork.ownWidth + nb.width) / 2 })).filter((o) => o.points && o.need > 0);
  if (!others.length) return null;
  for (let step = 0; step < n; step += 1) {
    const i = atStart ? step : n - 1 - step;
    const value = Math.max(...others.map((o) => 1 - distanceToLine(o.points, points[i * 3], points[i * 3 + 1]) / o.need));
    if (value <= 0) break;
    // Drugi koniec wayu pozostaje na miejscu: tam łączy się z inną jezdnią albo sam jest węzłem rozwidlenia.
    const far = atStart ? plan.length - plan.along[i] : plan.along[i];
    share[i] = Math.min(1, value, far / FORK_FAR_END_METERS);
  }
  return share;
}

/**
 * Białe linie krawędziowe po obu stronach jezdni z oznakowaniem pasów. Linia jest przerywana tam, gdzie leży na innej
 * jezdni tego samego poziomu połączonej z nią węzłem (wylot bocznej drogi, wnętrze skrzyżowania). Nie przerywa jej
 * kontynuacja tej samej jezdni, gałąź rozwidlenia, jezdnia na innym poziomie ani jezdnia bez wspólnego węzła. Jezdnie stykające się bokiem mają więc ciągłą linię między sobą.
 */
function* applyEdgeLines(model, plans, ends, roadsAtNode) {
  // lineHalf: odległość osi linii krawędziowej od brzegu nawierzchni (odsunięcie od brzegu i połowa szerokości linii).
  const cfg = model.profile.surfaces, lineHalf = (cfg.edgeLineInsetMeters ?? 0) + cfg.edgeLineWidthMeters / 2;
  const widthAt = (plan, s) => transitionWidthAt(plan, s) ?? plan.width ?? 0;
  // Kontynuacja: dokładnie dwa końce w węźle i żadna inna jezdnia przez niego nie przechodzi.
  const peers = new Map(), pair = (a, b) => { for (const [x, y] of [[a, b], [b, a]]) { if (!peers.has(x)) peers.set(x, new Set()); peers.get(x).add(y.id); } };
  for (const [ref, list] of ends) {
    const through = new Set((roadsAtNode.get(ref) ?? []).map((s) => s.feature.id));
    if (list.length === 2 && through.size === 2) { pair(list[0].plan, list[1].plan); continue; }
    for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) if (list[i].hx * list[j].hx + list[i].hy * list[j].hy < EDGE_STRAIGHT_COS) pair(list[i].plan, list[j].plan);
  }
  // Klucz liczbowy komórki (całkowite indeksy do ±2^20).
  const cellKey = (i, j) => (i + 1048576) * 2097152 + (j + 1048576);
  const grid = new Map(), cell = (x, y) => cellKey(Math.floor(x / EDGE_CELL_METERS), Math.floor(y / EDGE_CELL_METERS));
  for (const plan of plans.values()) {
    const state = model.states.get(plan.id);
    if (!state.interp.classDef.carriageway || plan.width === undefined) continue;
    const { axis, along } = plan, z = state.level?.z;
    for (let k = 1; k < along.length; k += 1) {
      const seg = { plan, ax: axis[k * 3 - 3], ay: axis[k * 3 - 2], bx: axis[k * 3], by: axis[k * 3 + 1], ha: widthAt(plan, along[k - 1]) / 2, hb: widthAt(plan, along[k]) / 2, za: z?.[k - 1], zb: z?.[k] };
      const reach = Math.max(seg.ha, seg.hb);
      for (let i = Math.floor((Math.min(seg.ax, seg.bx) - reach) / EDGE_CELL_METERS); i <= Math.floor((Math.max(seg.ax, seg.bx) + reach) / EDGE_CELL_METERS); i += 1) {
        for (let j = Math.floor((Math.min(seg.ay, seg.by) - reach) / EDGE_CELL_METERS); j <= Math.floor((Math.max(seg.ay, seg.by) + reach) / EDGE_CELL_METERS); j += 1) {
          const key = cellKey(i, j);
          let list = grid.get(key);
          if (!list) { list = []; grid.set(key, list); }
          list.push(seg);
        }
      }
    }
  }
  let done = 0;
  for (const plan of plans.values()) {
    if (!plan.edgeLine) continue;
    if ((done += 1) % EDGE_BATCH === 0) yield "nawierzchnie: linie krawędziowe";
    const state = model.states.get(plan.id), z = state.level?.z, { axis, along, length } = plan;
    const skip = new Set([plan.id, ...(peers.get(plan) ?? []), ...(plan.forkPeers ?? [])]);
    // Skrzyżowanie w jednym poziomie ma w OSM wspólny węzeł; jezdnia równoległa bez połączenia nie przerywa linii, nawet gdy na nią nachodzi.
    const ownNodes = new Set(state.feature.nodeRefs), linked = new Map();
    const connected = (other) => { if (!linked.has(other)) linked.set(other, model.states.get(other.id).feature.nodeRefs.some((r) => ownNodes.has(r))); return linked.get(other); };
    // Odcinki komórki, które mogą przerwać tę linię (inna, połączona jezdnia); wybór nie zależy od punktu, więc jest liczony raz na komórkę.
    const candidates = new Map();
    const candidatesAt = (key) => {
      let list = candidates.get(key);
      if (!list) { list = (grid.get(key) ?? []).filter((g) => !skip.has(g.plan.id) && connected(g.plan)); candidates.set(key, list); }
      return list;
    };
    const stations = [];
    for (let s = 0; s < length; s += EDGE_STEP_METERS) stations.push(s);
    stations.push(length);
    plan.edgeLine.sides = [-1, 1].map((side) => {
      const pieces = [];
      const covered = (s) => {
        const k = segmentAt(along, s);
        const span = along[k] - along[k - 1] || 1, f = Math.max(0, Math.min(1, (s - along[k - 1]) / span));
        const ax = axis[k * 3 - 3], ay = axis[k * 3 - 2], dx = axis[k * 3] - ax, dy = axis[k * 3 + 1] - ay, l = Math.hypot(dx, dy) || 1;
        const off = side * (widthAt(plan, s) / 2 - lineHalf), x = ax + dx * f + (dy / l) * off, y = ay + dy * f - (dx / l) * off;
        const h = z ? z[k - 1] + (z[k] - z[k - 1]) * f : undefined;
        // Punkt leży na innej jezdni: rzut na jej odcinek mieści się w nim (bez zaokrąglenia końca) i głębiej niż jej linia krawędziowa,
        // więc linia kończy się dokładnie na linii krawędziowej drugiej jezdni i obie spotykają się w narożniku.
        return candidatesAt(cell(x, y)).some((g) => {
          const gx = g.bx - g.ax, gy = g.by - g.ay, l2 = gx * gx + gy * gy;
          if (!l2) return false;
          const t = ((x - g.ax) * gx + (y - g.ay) * gy) / l2;
          if (t < 0 || t > 1) return false;
          const d = Math.abs((x - g.ax) * gy - (y - g.ay) * gx) / Math.sqrt(l2), half = g.ha + (g.hb - g.ha) * t;
          if (d >= half - lineHalf) return false;
          const gz = g.za !== undefined && g.zb !== undefined ? g.za + (g.zb - g.za) * t : undefined;
          return h === undefined || gz === undefined || Math.abs(h - gz) < EDGE_LEVEL_METERS;
        });
      };
      // Granica między próbkami jest wyznaczana bisekcją z dokładnością kilku milimetrów.
      const edge = (a, b, coveredAtA) => { for (let i = 0; i < EDGE_BISECT_STEPS; i += 1) { const m = (a + b) / 2; if (covered(m) === coveredAtA) a = m; else b = m; } return (a + b) / 2; };
      let from = null, previous = null, previousCovered = null;
      for (const s of stations) {
        const now = covered(s);
        if (previous === null) { if (!now) from = s; }
        else if (now !== previousCovered) {
          const at = edge(previous, s, previousCovered);
          if (now) { pieces.push([from, at]); from = null; } else from = at;
        }
        previous = s; previousCovered = now;
      }
      if (from !== null) pieces.push([from, length]);
      return { side, pieces: pieces.filter(([a, b]) => b - a >= EDGE_MIN_PIECE_METERS) };
    });
  }
  yield "nawierzchnie: linie krawędziowe";
  snapEdgeCorners(plans, widthAt, lineHalf);
}

/**
 * Narożnik: koniec linii krawędziowej przy wlocie trafia w punkt przecięcia z linią krawędziową sąsiedniej jezdni.
 * Przy węźle granica ucięcia liczona z pasa drugiej jezdni może rozminąć się z jej linią (rzut wypada przed początkiem
 * jej odcinka), więc koniec jest przesuwany do 2 m tak, aby obie linie spotkały się bez przerwy i bez nachodzenia.
 */
function snapEdgeCorners(plans, widthAt, lineHalf) {
  const SNAP = 2, STEP = 0.05, MATCH = 1.5;
  const pointAt = (plan, side, s) => {
    const { axis, along } = plan, k = segmentAt(along, s);
    const span = along[k] - along[k - 1] || 1, f = (s - along[k - 1]) / span;
    const ax = axis[k * 3 - 3], ay = axis[k * 3 - 2], dx = axis[k * 3] - ax, dy = axis[k * 3 + 1] - ay, l = Math.hypot(dx, dy) || 1;
    const off = side * (widthAt(plan, Math.max(0, Math.min(plan.length, s))) / 2 - lineHalf);
    return [ax + dx * f + (dy / l) * off, ay + dy * f - (dx / l) * off];
  };
  const ends = [];
  for (const plan of plans.values()) {
    for (const line of plan.edgeLine?.sides ?? []) {
      line.pieces.forEach((piece, i) => {
        for (const which of [0, 1]) {
          const s = piece[which];
          if (s < 0.01 || s > plan.length - 0.01) continue;
          ends.push({ plan, line, piece, which, s, p: pointAt(plan, line.side, s) });
        }
      });
    }
  }
  // Odcinki linii krawędziowych (co 0,25 m) w siatce 10 m, do szukania linii sąsiedniej jezdni przy końcu. Zapytania dotyczą
  // tylko komórek wokół końców, więc zapisywane są wyłącznie odcinki w tych komórkach (te same listy, ta sama kolejność).
  const cellKey = (i, j) => (i + 1048576) * 2097152 + (j + 1048576);
  const grid = new Map(), key = (x, y) => cellKey(Math.floor(x / 10), Math.floor(y / 10)), needed = new Set();
  for (const end of ends) {
    const ci = Math.floor(end.p[0] / 10), cj = Math.floor(end.p[1] / 10);
    for (let i = -1; i <= 1; i += 1) for (let j = -1; j <= 1; j += 1) needed.add(cellKey(ci + i, cj + j));
  }
  const neededCells = [...needed].map((k) => [Math.floor(k / 2097152) - 1048576, (k % 2097152) - 1048576]);
  // Linia leży najdalej o pół szerokości jezdni od osi: jezdnia bez potrzebnej komórki w tym pasie jest pomijana.
  const touchesNeeded = (plan) => {
    const { axis } = plan, reach = Math.max(plan.width ?? 0, plan.widthStart ?? 0, plan.widthEnd ?? 0) / 2 + lineHalf + 1;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < axis.length; k += 3) { x0 = Math.min(x0, axis[k]); x1 = Math.max(x1, axis[k]); y0 = Math.min(y0, axis[k + 1]); y1 = Math.max(y1, axis[k + 1]); }
    const i0 = Math.floor((x0 - reach) / 10), i1 = Math.floor((x1 + reach) / 10), j0 = Math.floor((y0 - reach) / 10), j1 = Math.floor((y1 + reach) / 10);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) <= neededCells.length) {
      for (let i = i0; i <= i1; i += 1) for (let j = j0; j <= j1; j += 1) if (needed.has(cellKey(i, j))) return true;
      return false;
    }
    return neededCells.some(([i, j]) => i >= i0 && i <= i1 && j >= j0 && j <= j1);
  };
  for (const plan of plans.values()) {
    if (!plan.edgeLine?.sides?.length || !touchesNeeded(plan)) continue;
    for (const line of plan.edgeLine?.sides ?? []) {
      for (const [a, b] of line.pieces) {
        // Koniec odcinka jest początkiem następnego (ten sam punkt), więc liczony jest raz.
        let p = a < b ? pointAt(plan, line.side, a) : null;
        for (let s = a; s < b; s += 0.25) {
          const q = pointAt(plan, line.side, Math.min(b, s + 0.25)), k = key(p[0], p[1]);
          if (needed.has(k)) {
            let list = grid.get(k);
            if (!list) { list = []; grid.set(k, list); }
            list.push({ plan, p, q });
          }
          p = q;
        }
      }
    }
  }
  const moves = [];
  for (const end of ends) {
    const near = [];
    for (let i = -1; i <= 1; i += 1) for (let j = -1; j <= 1; j += 1) for (const seg of grid.get(cellKey(Math.floor(end.p[0] / 10) + i, Math.floor(end.p[1] / 10) + j)) ?? []) if (seg.plan !== end.plan) near.push(seg);
    // Tylko linia sąsiedniej jezdni bliżej niż 1,5 m od końca jest partnerem narożnika.
    if (!near.length) continue;
    const probes = [];
    for (let s = Math.max(0, end.s - SNAP); s <= Math.min(end.plan.length, end.s + SNAP); s += STEP) probes.push([s, pointAt(end.plan, end.line.side, s)]);
    // Odcinki dalsze niż MATCH od wszystkich próbek nie zmieniają żadnej odległości, od której zależy decyzja (≤ MATCH), więc są pomijane.
    let x0 = end.p[0], y0 = end.p[1], x1 = x0, y1 = y0;
    for (const [, [x, y]] of probes) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const reach = MATCH + 0.01;
    const close = near.filter(({ p: a, q: b }) => Math.max(a[0], b[0]) >= x0 - reach && Math.min(a[0], b[0]) <= x1 + reach && Math.max(a[1], b[1]) >= y0 - reach && Math.min(a[1], b[1]) <= y1 + reach);
    const distance = ([x, y]) => distanceToPieces(close, x, y);
    const here = distance(end.p);
    if (here > MATCH || here < 0.01) continue;
    let target = null, closest = Infinity;
    for (const [s, point] of probes) {
      const d = distance(point);
      if (d < closest) { closest = d; target = s; }
    }
    if (closest < 0.05) moves.push([end, target]);
  }
  for (const [end, s] of moves) end.piece[end.which] = s;
  // Obie linie kończą się przed punktem przecięcia: oba końce przesuwają się do wspólnego punktu (najbliższa para w promieniu 2 m).
  const moved = new Set(moves.map(([end]) => end)), loose = ends.filter((end) => !moved.has(end));
  // Kandydaci z siatki komórek o boku MATCH; przy równej odległości wygrywa wcześniejszy koniec, jak w pełnym przeglądzie.
  const done = new Set(), looseGrid = new Map(), looseKey = (i, j) => `${i}:${j}`;
  loose.forEach((end, order) => {
    end.order = order;
    const k = looseKey(Math.floor(end.p[0] / MATCH), Math.floor(end.p[1] / MATCH));
    if (!looseGrid.has(k)) looseGrid.set(k, []);
    looseGrid.get(k).push(end);
  });
  for (const a of loose) {
    if (done.has(a)) continue;
    let b = null, best = MATCH;
    const ci = Math.floor(a.p[0] / MATCH), cj = Math.floor(a.p[1] / MATCH);
    for (let i = ci - 1; i <= ci + 1; i += 1) {
      for (let j = cj - 1; j <= cj + 1; j += 1) {
        for (const other of looseGrid.get(looseKey(i, j)) ?? []) {
          if (other.plan === a.plan || done.has(other)) continue;
          const d = Math.hypot(other.p[0] - a.p[0], other.p[1] - a.p[1]);
          if (d < best || (d === best && b && other.order < b.order)) { best = d; b = other; }
        }
      }
    }
    if (!b || best < 0.01) continue;
    let pair = null, closest = Infinity;
    for (let sa = Math.max(0, a.s - SNAP); sa <= Math.min(a.plan.length, a.s + SNAP); sa += 0.1) {
      const pa = pointAt(a.plan, a.line.side, sa);
      for (let sb = Math.max(0, b.s - SNAP); sb <= Math.min(b.plan.length, b.s + SNAP); sb += 0.1) {
        const pb = pointAt(b.plan, b.line.side, sb), d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
        if (d < closest) { closest = d; pair = [sa, sb]; }
      }
    }
    if (closest < 0.1) { a.piece[a.which] = pair[0]; b.piece[b.which] = pair[1]; done.add(a); done.add(b); }
  }
  for (const plan of plans.values()) for (const line of plan.edgeLine?.sides ?? []) line.pieces = line.pieces.filter(([a, b]) => b - a >= EDGE_MIN_PIECE_METERS);
}

/** Końce jezdni w węzłach z kierunkiem od węzła w głąb jezdni. */
function carriagewayEnds(model, plans) {
  const ends = new Map();
  for (const plan of plans.values()) {
    const state = model.states.get(plan.id);
    if (!state.interp.classDef.carriageway) continue;
    const refs = state.feature.nodeRefs, p = state.feature.points, n = p.length / 3;
    if (n < 2) continue;
    const width = state.interp.dimensions.width?.value ?? state.interp.classDef.widthMeters ?? 6;
    for (const atStart of [true, false]) {
      const a = atStart ? 0 : n - 1, b = atStart ? 1 : n - 2, ref = atStart ? refs[0] : refs[refs.length - 1];
      const hx = p[b * 3] - p[a * 3], hy = p[b * 3 + 1] - p[a * 3 + 1], l = Math.hypot(hx, hy) || 1;
      if (!ends.has(ref)) ends.set(ref, []);
      ends.get(ref).push({ plan, atStart, hx: hx / l, hy: hy / l, width: (plan.laneWidths ? (atStart ? plan.widthStart : plan.widthEnd) : null) ?? width });
    }
  }
  return ends;
}

/**
 * Rozwidlenie (lub złączenie) jezdni: jeden pień po jednej stronie węzła i co najmniej dwie gałęzie po drugiej.
 * Gałęzie leżą obok siebie w kolejności z geometrii, razem na szerokości pnia; dane OSM pozostają bez zmian.
 */
function findForks(ends, handled) {
  for (const [ref, list] of ends) {
    // Węzeł opisany relacją connectivity ma położenie gałęzi z relacji.
    if (list.length < 3 || handled.has(ref)) continue;
    for (const trunk of list) {
      const dx = -trunk.hx, dy = -trunk.hy;
      const group = list.filter((e) => e !== trunk && e.hx * dx + e.hy * dy > FORK_COS);
      if (group.length < 2 || group.length + 1 !== list.length) continue;
      // Rozwidlenie wynika z tagów pasów: pasy pnia to suma pasów gałęzi albo pień jest odcinkiem przejściowym.
      if (group.some((e) => !e.plan.lanes)) continue;
      const total = group.reduce((t, e) => t + e.width, 0), lanes = group.reduce((t, e) => t + e.plan.lanes, 0);
      if (!trunk.plan.transition && (trunk.plan.lanes !== lanes || Math.abs(trunk.width - total) > FORK_WIDTH_TOLERANCE * total)) continue;
      // Od lewej do prawej patrząc od pnia w stronę gałęzi.
      const rx = dy, ry = -dx;
      group.sort((a, b) => (a.hx * rx + a.hy * ry) - (b.hx * rx + b.hy * ry));
      // Gałęzie układają się wokół narysowanej osi pnia, która przy placement nie leży w węźle.
      const trunkOffset = (trunk.atStart ? trunk.plan.offsetStart : trunk.plan.offsetEnd) ?? trunk.plan.centerOffset ?? 0;
      const sx = (trunk.atStart ? trunk.hy : -trunk.hy) * trunkOffset, sy = (trunk.atStart ? -trunk.hx : trunk.hx) * trunkOffset;
      let from = -total / 2;
      group.forEach((e, i) => { e.neighbours = [group[i - 1], group[i + 1]].filter(Boolean).map((x) => ({ id: x.plan.id, width: x.width })); });
      for (const e of group) {
        const position = from + e.width / 2;
        from += e.width;
        // Przesunięcie jest liczone w prawo od kierunku wayu: way wchodzący do węzła biegnie przeciwnie do gałęzi.
        e.plan.forks ??= {};
        e.plan.forks[e.atStart ? "start" : "end"] = { offset: e.atStart ? position : -position, vx: sx + rx * position, vy: sy + ry * position, trunk: trunk.plan.id, total, ownWidth: e.width, neighbours: e.neighbours, hx: trunk.hx, hy: trunk.hy };
        (e.plan.forkPeers ??= new Set()).add(trunk.plan.id);
        (trunk.plan.forkPeers ??= new Set()).add(e.plan.id);
      }
      trunk.plan.forkTotal ??= {};
      trunk.plan.forkTotal[trunk.atStart ? "start" : "end"] = total;
      (trunk.plan.forkLanes ??= {})[trunk.atStart ? "start" : "end"] = lanes;
      (trunk.plan.forkHeading ??= {})[trunk.atStart ? "start" : "end"] = [trunk.hx, trunk.hy];
    }
  }
}

/**
 * Szerokość odcinków przejściowych na końcach: szerokość sąsiada, łączna szerokość gałęzi rozwidlenia,
 * a w ciągu kilku odcinków przejściowych zmiana liniowa wzdłuż całego ciągu, aby styki nie tworzyły uskoku.
 */
function applyTransitionWidths(model, plans, ends, issues) {
  const nodeOf = (plan, atStart) => { const refs = model.states.get(plan.id).feature.nodeRefs; return atStart ? refs[0] : refs[refs.length - 1]; };
  const entryOf = (plan, atStart) => (ends.get(nodeOf(plan, atStart)) ?? []).find((e) => e.plan === plan && e.atStart === atStart);
  const others = (plan, atStart) => (ends.get(nodeOf(plan, atStart)) ?? []).filter((e) => e.plan !== plan);
  const link = (plan, atStart) => { const list = others(plan, atStart); return list.length === 1 && list[0].plan.transition ? list[0] : null; };
  const terminal = (plan, atStart) => {
    const own = entryOf(plan, atStart);
    if (!own) return null;
    const fork = plan.forkTotal?.[atStart ? "start" : "end"];
    if (fork) return fork;
    const list = others(plan, atStart).filter((e) => !e.plan.transition);
    if (list.length === 1) return list[0].width;
    // Kilka jezdni w węźle: liczą się te, które biegną dalej na wprost tego odcinka.
    const ahead = list.filter((e) => e.hx * own.hx + e.hy * own.hy < -FORK_COS);
    return ahead.length ? ahead.reduce((t, e) => t + e.width, 0) : own.width;
  };
  // Liczba pasów sąsiada na końcu ciągu: jedna jezdnia dalej, suma gałęzi rozwidlenia; null, gdy nie wiadomo.
  const terminalLanes = (plan, atStart) => {
    const own = entryOf(plan, atStart), fork = plan.forkLanes?.[atStart ? "start" : "end"];
    if (fork) return fork;
    const list = others(plan, atStart).filter((e) => !e.plan.transition);
    const ahead = list.length === 1 ? list : list.filter((e) => own && e.hx * own.hx + e.hy * own.hy < -FORK_COS);
    if (!ahead.length || ahead.some((e) => !e.plan.lanes || !e.plan.direction)) return null;
    return ahead.reduce((t, e) => t + e.plan.lanes, 0);
  };
  const done = new Set();
  for (const plan of plans.values()) {
    if (!plan.transition || done.has(plan) || !entryOf(plan, true)) continue;
    // Początek ciągu odcinków przejściowych.
    let head = plan, free = true;
    const seen = new Set([plan]);
    for (;;) { const l = link(head, free); if (!l || seen.has(l.plan)) break; seen.add(l.plan); head = l.plan; free = !l.atStart; }
    const chain = [{ plan: head, entry: free }];
    for (;;) {
      const last = chain[chain.length - 1], l = link(last.plan, !last.entry);
      if (!l || chain.some((c) => c.plan === l.plan)) break;
      chain.push({ plan: l.plan, entry: l.atStart });
    }
    const tail = chain[chain.length - 1];
    const a = terminal(head, free) ?? entryOf(head, free).width, b = terminal(tail.plan, !tail.entry) ?? entryOf(tail.plan, !tail.entry).width;
    const total = chain.reduce((t, c) => t + c.plan.length, 0) || 1;
    let walked = 0;
    for (const c of chain) {
      const wIn = a + (b - a) * (walked / total), wOut = a + (b - a) * ((walked + c.plan.length) / total);
      walked += c.plan.length;
      c.plan.widthStart = c.entry ? wIn : wOut; c.plan.widthEnd = c.entry ? wOut : wIn;
      done.add(c.plan);
      // Odcinek przejściowy z width:lanes ma szerokości końców z tagów.
      if (c.plan.laneWidths) { c.plan.widthStart = sum(c.plan.laneWidths.start); c.plan.widthEnd = sum(c.plan.laneWidths.end); continue; }
      // Liczba pasów odcinka przejściowego musi mieścić się między sąsiadami; inaczej szerokość z sąsiadów jej nie pokaże.
      const own = c.plan.lanes && c.plan.laneWidth ? c.plan.lanes * c.plan.laneWidth : null, low = Math.min(a, b), high = Math.max(a, b);
      if (own !== null && (own > high + 0.05 || own < low - 0.05)) {
        const state = model.states.get(c.plan.id), p = state.feature.points;
        issues.push({ key: `transition-lanes:${c.plan.id}`, code: "transition-lanes", category: "uncertain", status: "informacja", severity: 1, confidence: "wysoka",
          message: `Odcinek przejściowy ma lanes=${c.plan.lanes} (${own.toFixed(2)} m), a sąsiednie jezdnie mają szerokość od ${low.toFixed(2)} do ${high.toFixed(2)} m.`,
          reason: "Szerokość odcinka przejściowego wynika z sąsiadów, więc tej liczby pasów nie widać; pasy są zwężone. Prawdopodobnie sąsiad ma błędną liczbę pasów albo odcinek przejściowy powinien obejmować także sąsiada.",
          objects: [c.plan.id], location: [p[0], p[1], p[2] ?? 0], suggest: [{ key: "placement", reason: "placement=transition łączy krawędzie sąsiednich jezdni.", doc: "https://wiki.openstreetmap.org/wiki/Proposal:Placement" }] });
      }
      c.plan.provenance.width = { value: `od ${c.plan.widthStart.toFixed(1)} m na początku do ${c.plan.widthEnd.toFixed(1)} m na końcu`, source: chain.length > 1 ? `placement=transition: ciąg ${chain.length} odcinków przejściowych między sąsiednimi jezdniami` : "placement=transition: szerokości sąsiednich jezdni", approximate: true };
    }
    applyTransitionLanes(chain, head, free, tail, a, b, total, terminalLanes);
  }
}

/**
 * Układ pasów ciągu odcinków przejściowych bez width:lanes: na każdym końcu tyle pasów, ile ma sąsiednia jezdnia.
 * Pas istniejący tylko na jednym końcu zwęża się do zera po stronie ruchu (przy ruchu prawostronnym prawej, założenie)
 * i ma własną linię, więc pas pojawiający się i zanikający jest widoczny. Dotyczy jezdni jednokierunkowych.
 */
function applyTransitionLanes(chain, head, free, tail, a, b, total, terminalLanes) {
  if (!chain.every((c) => c.plan.direction && c.plan.lanes && !c.plan.laneWidths)) return;
  const along = (c) => c.entry === (c.plan.direction === 1);
  if (!chain.every((c) => along(c) === along(chain[0]))) return;
  const nA = terminalLanes(head, free) ?? head.lanes, nB = terminalLanes(tail.plan, !tail.entry) ?? tail.plan.lanes, n = Math.max(nA, nB);
  // Szerokości pasów od lewej patrząc w kierunku ruchu; brakujące pasy leżą z prawej strony.
  const first = Array.from({ length: n }, (_, i) => (i < nA ? a / nA : 0)), last = Array.from({ length: n }, (_, i) => (i < nB ? b / nB : 0));
  const at = (f) => first.map((w, i) => w + (last[i] - w) * f);
  let walked = 0;
  for (const c of chain) {
    const plan = c.plan, f0 = walked / total, f1 = (walked + plan.length) / total;
    walked += plan.length;
    let wIn = at(f0), wOut = at(f1);
    if (plan.direction === -1) { wIn = wIn.reverse(); wOut = wOut.reverse(); }
    plan.laneWidths = { start: c.entry ? wIn : wOut, end: c.entry ? wOut : wIn, derived: true };
    const old = plan.lanes;
    plan.lanes = n;
    if (old !== n && plan.provenance.markings && plan.provenance.markings.source !== "tag lane_markings=no") {
      const confirmed = plan.dividers[0]?.confirmed ?? false;
      plan.dividers = Array.from({ length: n - 1 }, (_, k) => ({ offset: 0, lane: k + 1, confirmed, dashes: [] }));
      // Przy oneway=-1 dodatkowe pasy z prawej strony ruchu leżą z lewej strony wayu: numery pasów strzałek przesuwają się.
      if (plan.direction === -1) for (const arrow of plan.arrows) arrow.lane += n - old;
    }
    if (nA !== nB || old !== n) plan.provenance.markings = { value: `pasy ${nA} → ${nB}`, source: `liczba pasów sąsiednich jezdni${old !== n ? ` (tag lanes=${old} na odcinku przejściowym)` : ""}; pas pojawiający się lub zanikający leży po stronie ruchu (założenie)`, approximate: true };
  }
}

/** Szerokość odcinka przejściowego w danym miejscu (m). */
export function transitionWidthAt(plan, s) {
  if (plan.widthStart === undefined) return null;
  return plan.widthStart + (plan.widthEnd - plan.widthStart) * (plan.length ? Math.max(0, Math.min(1, s / plan.length)) : 0);
}

/**
 * Położenie granicy pasów k (0 = lewa krawędź, lanes = prawa) względem osi jezdni na odcinku przejściowym.
 * Pasy zachowują szerokość z tagów; zmianę szerokości przejmuje skrajny pas od strony ruchu (przy ruchu prawostronnym prawy),
 * a na jezdni dwukierunkowej pasy dzielą szerokość równo. Gdy jezdnia jest za wąska, pasy zwężają się równo.
 */
export function laneOffset(plan, k, s, drivingSide = "right") {
  const w = transitionWidthAt(plan, s);
  if (w === null || !plan.lanes) return null;
  // width:lanes: każda granica pasa przesuwa się liniowo między położeniem na początku i na końcu wayu.
  if (plan.laneWidths) {
    const f = plan.length ? Math.max(0, Math.min(1, s / plan.length)) : 0, i = Math.max(0, Math.min(plan.lanes, k));
    const a = edgesOf(plan.laneWidths.start)[i], b = edgesOf(plan.laneWidths.end)[i];
    return a + (b - a) * f - w / 2;
  }
  const lw = Math.min(plan.laneWidth, w / plan.lanes), anchor = plan.direction ? plan.direction * (drivingSide === "right" ? 1 : -1) : 0;
  let fromLeft;
  if (k <= 0) fromLeft = 0;
  else if (k >= plan.lanes) fromLeft = w;
  else fromLeft = anchor > 0 ? k * lw : anchor < 0 ? w - (plan.lanes - k) * lw : (k / plan.lanes) * w;
  return fromLeft - w / 2;
}

/** Odcinki przejść leżące na jezdni tego samego poziomu oraz strefy, które ta jezdnia musi zostawić wolne. */
function applyCrossingSpans(model, plans, nodeCrossings, pathsAtNode, roadsAtNode) {
  const cfg = model.profile.surfaces, crossingPlans = [...plans.values()].filter((p) => p.crossing);
  const halfOf = (plan) => { const { interp } = model.states.get(plan.id); return (interp.dimensions.width?.value ?? interp.classDef.widthMeters ?? 2) / 2; };
  // Każde przejście przez jezdnię, także bez malowania, zajmuje jej szerokość na szerokości przejścia (crossZones przerywają linię krawędziową).
  const keepClear = (road, from, to, extent) => { road.clearZones.push([from - extent - cfg.crossingClearMeters, to + extent + cfg.crossingClearMeters]); road.crossZones.push([from - extent, to + extent]); };
  const grid = new Map(), keyOf = (x, y) => `${Math.floor(x / SPAN_CELL_METERS)}:${Math.floor(y / SPAN_CELL_METERS)}`;
  for (const plan of plans.values()) {
    const state = model.states.get(plan.id), def = state.interp.classDef;
    // Ścieżka rowerowa przyjmuje malowanie tylko od przejścia połączonego z nią wspólnym węzłem.
    if (!def.carriageway && def.routeLine !== "routeLinesCycle") continue;
    const half = (state.interp.dimensions.width?.value ?? def.widthMeters ?? 6) / 2, { axis, along } = plan, z = state.level?.z;
    for (let i = 3; i < axis.length; i += 3) {
      const k = i / 3, segment = { plan, carriageway: Boolean(def.carriageway), ax: axis[i - 3], ay: axis[i - 2], bx: axis[i], by: axis[i + 1], za: z?.[k - 1], zb: z?.[k], half, s0: along[k - 1], s1: along[k] };
      const x0 = Math.floor((Math.min(segment.ax, segment.bx) - half) / SPAN_CELL_METERS), x1 = Math.floor((Math.max(segment.ax, segment.bx) + half) / SPAN_CELL_METERS);
      const y0 = Math.floor((Math.min(segment.ay, segment.by) - half) / SPAN_CELL_METERS), y1 = Math.floor((Math.max(segment.ay, segment.by) + half) / SPAN_CELL_METERS);
      for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) { const key = `${x}:${y}`; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(segment); }
    }
  }
  // Jezdnia połączona z przejściem wspólnym węzłem jest tym samym poziomem także na pochyleniu.
  const roadsAt = (x, y, z, linked, self) => (grid.get(keyOf(x, y)) ?? []).flatMap((g) => {
    const dx = g.bx - g.ax, dy = g.by - g.ay, t = Math.max(0, Math.min(1, ((x - g.ax) * dx + (y - g.ay) * dy) / (dx * dx + dy * dy || 1)));
    if (Math.hypot(x - g.ax - t * dx, y - g.ay - t * dy) > g.half || g.plan === self || (!g.carriageway && !linked.has(g.plan))) return [];
    if (!linked.has(g.plan) && z !== undefined && g.za !== undefined && Math.abs(z - (g.za + (g.zb - g.za) * t)) > SPAN_LEVEL_METERS) return [];
    return [{ plan: g.plan, s: g.s0 + (g.s1 - g.s0) * t }];
  });
  const addZone = (road, from, to, extent) => {
    road.coreZones.push([from - extent, to + extent]);
    keepClear(road, from, to, extent);
  };
  // Przejście bez znanego malowania też zajmuje jezdnię, więc pasy i strzałki je omijają.
  for (const plan of [...plans.values()].filter((p) => p.crossingObject)) {
    const state = model.states.get(plan.id), z = state.level?.z, { axis, along, length } = plan, spans = [];
    // Ścieżka liczy się tylko wtedy, gdy przejście i ona przechodzą przez wspólny węzeł; dojście na końcu przejścia nie jest przecinane.
    const refs = state.feature.nodeRefs, linked = new Set(refs.flatMap((ref, index) => [
      ...(roadsAtNode.get(ref) ?? []).map((road) => plans.get(road.feature.id)),
      ...(index > 0 && index < refs.length - 1 ? (pathsAtNode.get(ref) ?? []).filter((entry) => entry.through).map((entry) => entry.plan) : []),
    ]));
    let open = null, touched = null, last = 0, i = 1;
    for (let s = 0; s <= length; s += SPAN_STEP_METERS) {
      while (i < along.length - 1 && along[i] < s) i += 1;
      const t = Math.min(1, (s - along[i - 1]) / (along[i] - along[i - 1] || 1)), at = (k) => axis[(i - 1) * 3 + k] + (axis[i * 3 + k] - axis[(i - 1) * 3 + k]) * t;
      const roads = roadsAt(at(0), at(1), z ? z[i - 1] + (z[i] - z[i - 1]) * t : undefined, linked, plan);
      if (roads.length && open === null) { open = s; touched = new Map(); }
      for (const road of roads) {
        const seen = touched.get(road.plan);
        if (seen) { seen[0] = Math.min(seen[0], road.s); seen[1] = Math.max(seen[1], road.s); } else touched.set(road.plan, [road.s, road.s]);
      }
      if (!roads.length && open !== null) { spans.push({ from: open, to: last, touched }); open = null; }
      last = s;
    }
    if (open !== null) spans.push({ from: open, to: last, touched });
    // Tag wayu obejmuje cały przebieg, a tag węzła tylko odcinek jezdni, na którym ten węzeł leży.
    const hasRoad = (span) => [...span.touched.keys()].some((road) => model.states.get(road.id).interp.classDef.carriageway);
    const painted = new Set(), usable = spans.filter((span) => span.to - span.from >= SPAN_MIN_METERS);
    if (plan.crossing) plan.crossing.compactHalf = halfOf(plan);
    for (const part of plan.crossing?.parts ?? []) {
      const own = usable.filter((span) => !part.stations || part.stations.some((s) => s >= span.from - SPAN_NODE_MARGIN_METERS && s <= span.to + SPAN_NODE_MARGIN_METERS));
      part.spans = own.map((span) => [span.from, span.to, !hasRoad(span)]);
      own.forEach((span) => painted.add(span));
    }
    for (const span of spans) {
      for (const [road, [from, to]] of span.touched) {
        // Linia trasy zwęża się tylko na jezdni; krótki odcinek na ścieżce dałby klin, a pasy i tak leżą nad nią.
        if (painted.has(span) && hasRoad(span)) addZone(road, from, to, plan.crossing.extent); else keepClear(road, from, to, halfOf(plan));
      }
    }
    if (!plan.crossing) continue;
    plan.crossing.spans = usable.filter((span) => painted.has(span)).map((span) => [span.from, span.to, !hasRoad(span)]);
    plan.lineZones = plan.crossing.spans.filter(([, , compact]) => !compact).map(([from, to]) => [from, to]);
    if (!plan.crossing.spans.length) plan.provenance.crossing = { ...plan.provenance.crossing, value: "bez malowania na rysunku", source: `${plan.provenance.crossing.source}; przebieg nie leży na jezdni tego poziomu`, approximate: true };
  }
  // Węzeł leżący na namalowanym przejściu tego samego rodzaju nie tworzy drugiego malowania.
  for (const [id, crossing] of nodeCrossings) {
    const duplicate = crossingPlans.some((plan) => plan.crossing.parts.some((part) => part.spans?.length && crossing.parts.some((own) => own.pattern === part.pattern)) && Array.from({ length: plan.axis.length / 3 }, (_, k) => Math.hypot(plan.axis[k * 3] - crossing.x, plan.axis[k * 3 + 1] - crossing.y)).some((d) => d < NODE_DUPLICATE_METERS));
    if (duplicate) { nodeCrossings.delete(id); continue; }
    addZone(plans.get(crossing.roadId), crossing.s, crossing.s, crossing.extent);
    // Trasa przechodząca przez węzeł przejścia biegnie po malowaniu na szerokości całej jezdni.
    for (const { plan, k } of pathsAtNode.get(crossing.osmId) ?? []) plan.lineZones.push([plan.along[k] - crossing.half, plan.along[k] + crossing.half]);
  }
  // Ścieżka przechodząca przez jezdnię we wspólnym węźle jest miejscem przecięcia także bez tagu przejścia.
  for (const [ref, paths] of pathsAtNode) {
    for (const road of roadsAtNode.get(ref) ?? []) {
      const roadPlan = plans.get(road.feature.id), s = roadPlan.along[road.feature.nodeIndex[road.feature.nodeRefs.indexOf(ref)]];
      for (const { plan, through } of paths) if (through) keepClear(roadPlan, s, s, halfOf(plan));
    }
  }
  for (const plan of plans.values()) {
    plan.clearZones = mergeZones(plan.clearZones); plan.coreZones = mergeZones(plan.coreZones); plan.crossZones = mergeZones([...plan.crossZones, ...plan.coreZones]);
    plan.lineZones = mergeZones([...plan.lineZones, ...plan.coreZones]);
    if (plan.dividers.length || plan.arrows.length) settleMarkings(plan, cfg);
  }
}

export function planAllSurfaces(model) { return finishSteps(planAllSurfacesSteps(model)); }

/** Plany nawierzchni etapami: yield po przejściach globalnych (linie krawędziowe, przejścia) przy doczytywaniu kafli. */
export function* planAllSurfacesSteps(model) {
  const byId = new Map(), issues = [], crossings = new Map(), crossingWays = new Map(), cfg = model.profile.surfaces;
  const stats = { surfaced: 0, tagged: 0, assumed: 0, unknownValue: 0, lines: 0, ways: { lanes: 0, dividers: 0, arrows: 0, noMarkings: 0, placement: 0, crossingWays: 0 }, crossingNodes: 0, crossingPatterns: {}, materials: {} };
  const roadsAtNode = new Map(), pathsAtNode = new Map(), nodeMarks = new Map();
  const timings = {};
  let clock = performance.now();
  const lap = (name) => { const now = performance.now(); timings[name] = Math.round(now - clock); clock = now; };
  for (const state of model.states.values()) {
    if (state.feature.geometry !== "way" || state.interp.geometry !== "line") continue;
    const plan = planWaySurface(state, model.profile), def = state.interp.classDef;
    byId.set(state.feature.id, plan);
    issues.push(...plan.issues);
    if (plan.line && plan.surfaced && !def.carriageway && !def.stairs) state.feature.nodeRefs.forEach((ref, i) => { if (!pathsAtNode.has(ref)) pathsAtNode.set(ref, []); pathsAtNode.get(ref).push({ plan, k: state.feature.nodeIndex[i], through: i > 0 && i < state.feature.nodeRefs.length - 1 }); });
    if (def.carriageway) for (const ref of state.feature.nodeRefs) { if (!roadsAtNode.has(ref)) roadsAtNode.set(ref, []); roadsAtNode.get(ref).push(state); }
    if (isCrossingWay(state.tagsNow, def)) for (const ref of state.feature.nodeRefs) { if (!crossingWays.has(ref)) crossingWays.set(ref, []); crossingWays.get(ref).push({ plan, s: plan.along[state.feature.nodeIndex[state.feature.nodeRefs.indexOf(ref)]] }); }
    if (!plan.surfaced) continue;
    stats.surfaced += 1;
    stats[plan.provenance.surface.approximate ? "assumed" : "tagged"] += 1;
    if (state.tagsNow.surface && plan.provenance.surface.approximate) stats.unknownValue += 1;
    if (plan.line) stats.lines += 1;
    stats.materials[plan.materialId] = (stats.materials[plan.materialId] ?? 0) + 1;
    if (plan.lanes) stats.ways.lanes += 1;
    if (state.tagsNow.lane_markings === "no") stats.ways.noMarkings += 1;
    if (plan.centerOffset) stats.ways.placement += 1;
  }
  lap("ways");
  yield "nawierzchnie: drogi"; clock = performance.now();
  const ends = carriagewayEnds(model, byId);
  lap("ends");
  const connectivity = applyConnectivity(model, byId, ends, cfg.drivingSide);
  issues.push(...connectivity.issues);
  stats.connectivity = { relations: [...(model.relations?.values() ?? [])].filter((r) => r.tags?.type === "connectivity").length, nodes: connectivity.handled.size, issues: connectivity.issues.length };
  lap("connectivity");
  findForks(ends, connectivity.handled);
  lap("forks");
  applyTransitionWidths(model, byId, ends, issues);
  lap("transitions");
  applyAxes(model, byId, ends);
  lap("axes");
  applyLaneContinuity(model, byId, ends, roadsAtNode);
  lap("continuity");
  yield "nawierzchnie: pasy"; clock = performance.now();
  yield* applyEdgeLines(model, byId, ends, roadsAtNode);
  lap("edgeLines");
  yield "nawierzchnie: linie krawędziowe"; clock = performance.now();
  for (const state of model.states.values()) {
    if (state.feature.geometry !== "point" || state.tagsNow.highway !== "crossing") continue;
    const tags = state.tagsNow, parts = crossingParts(tags, cfg, { markedFoot: true, markedCycle: true });
    if (!parts.length) continue;
    // Węzeł bez wayu przejścia rozstrzyga sam: rowerowy tylko przy bicycle=designated albo gdy pieszym jest zabroniony.
    const nodeServes = (part) => (part.applies === "foot" ? tags.foot !== "no" : tags.bicycle === "designated" || (tags.foot === "no" && tags.bicycle === "yes"));
    // Znak z węzła trafia do wayu właściwego rodzaju i dotyczy tylko jezdni przy tym węźle.
    const linked = crossingWays.get(state.feature.osmId) ?? [], unassigned = [];
    for (const part of parts) {
      const wanted = part.generic ? (part.applies === "foot" ? "markedFoot" : "markedCycle") : part.applies;
      const targets = linked.filter(({ plan }) => wanted === "any" || plan.crossingObject?.[wanted]);
      if (!targets.length) {
        if (!part.generic || (!linked.length && nodeServes(part))) unassigned.push(part);
        continue;
      }
      for (const { plan, s } of targets) if (!plan.crossing) (nodeMarks.get(plan) ?? nodeMarks.set(plan, []).get(plan)).push({ part, s });
    }
    if (!unassigned.length) continue;
    const road = roadsAtNode.get(state.feature.osmId)?.[0];
    if (!road) continue;
    const index = road.feature.nodeRefs.indexOf(state.feature.osmId), k = road.feature.nodeIndex[index], plan = byId.get(road.feature.id), { axis } = plan, n = axis.length / 3;
    const p = Math.max(0, k - 1), q = Math.min(n - 1, k + 1);
    let tx = axis[q * 3] - axis[p * 3], ty = axis[q * 3 + 1] - axis[p * 3 + 1];
    const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    const { items, extent } = layoutParts(unassigned, cfg);
    crossings.set(state.feature.id, { parts: items, extent, osmId: state.feature.osmId, x: axis[k * 3], y: axis[k * 3 + 1], z: road.level?.z[k] ?? axis[k * 3 + 2], tx, ty, s: plan.along[k], half: (road.interp.dimensions.width?.value ?? road.interp.classDef.widthMeters ?? 6) / 2, roadId: road.feature.id });
  }
  for (const [plan, marks] of nodeMarks) {
    const parts = new Map();
    for (const { part, s } of marks) {
      const key = `${part.pattern}|${part.source}|${part.value}`;
      if (!parts.has(key)) parts.set(key, { ...part, stations: [] });
      parts.get(key).stations.push(s);
    }
    setCrossing(plan, [...parts.values()], cfg, "węzeł: ");
  }
  lap("crossingNodes");
  yield "nawierzchnie: przejścia"; clock = performance.now();
  applyCrossingSpans(model, byId, crossings, pathsAtNode, roadsAtNode);
  lap("crossingSpans");
  const countPattern = (part) => { stats.crossingPatterns[part.pattern] = (stats.crossingPatterns[part.pattern] ?? 0) + 1; };
  for (const plan of byId.values()) {
    stats.ways.dividers += plan.dividers.some((d) => d.dashes.length) ? 1 : 0;
    stats.ways.arrows += plan.arrows.length ? 1 : 0;
    if (plan.crossing) stats.ways.crossingWays += 1;
    if (plan.crossing?.spans.length) plan.crossing.parts.forEach(countPattern);
  }
  for (const crossing of crossings.values()) crossing.parts.forEach(countPattern);
  stats.crossingNodes = crossings.size;
  stats.ways.crossingPainted = [...byId.values()].filter((p) => p.crossing?.spans.length).length;
  stats.timings = timings;
  return { byId, crossings, issues, stats };
}
