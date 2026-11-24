// Tunele, przejścia pod budynkami i przepusty jako bryła: tuba ze ścianami, stropem i portalami na wlotach.
// Wymiary pochodzą z tagów; gdy ich brak, z profilu kraju dla grupy trasy. Poziom posadzki pochodzi z modelu poziomów.

const CLEARANCE_KEYS = ["maxheight:physical", "maxheight"];
// Wartości maxheight, które nie są liczbą, ale są poprawne w OSM: nie dają wymiaru i nie są błędem.
const CLEARANCE_WORDS = new Set(["default", "none", "below_default", "no_sign", "no_indications", "unsigned"]);
const MAX_MITER = 2;

function parseMeters(raw) {
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*(m)?\s*$/.exec(raw ?? "");
  return match ? Number(match[1].replace(",", ".")) : null;
}

/** Rodzaj obiektu: tylko istniejące trasy transportowe i cieki; obiekty planowane nie dostają bryły. */
export function tunnelKind(state) {
  const { feature, interp } = state;
  if (feature.geometry !== "way" || interp.geometry !== "line") return null;
  const structure = interp.attributes.structure, def = interp.classDef;
  if (!["tunnel", "passage", "culvert"].includes(structure)) return null;
  if (def.levelCheck === "transport") return structure === "passage" ? "passage" : "tunnel";
  if (def.group === "water" && def.levelCheck === "water") return "culvert";
  return null;
}

function labelOf(kind, tags) {
  if (kind === "passage") return "Przejście pod budynkiem";
  if (kind === "culvert") return tags.tunnel === "culvert" ? "Przepust" : "Ciek w tunelu";
  return tags.tunnel === "passage" ? "Przejście podziemne" : "Tunel";
}

/** Budynki z obrysem i wysokością: przejście pod budynkiem nie może być wyższe niż on sam. */
function buildingRings(model) {
  const out = [];
  for (const state of model.states.values()) {
    const { feature, interp } = state;
    if (interp.classDef.group !== "buildings" || interp.geometry !== "area" || feature.geometry !== "way" || !feature.closed) continue;
    const ring = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < feature.points.length; i += 3) {
      const x = feature.points[i], y = feature.points[i + 1];
      ring.push([x, y]);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    out.push({ id: feature.id, ring, minX, minY, maxX, maxY, height: interp.dimensions.height?.value ?? null, minHeight: interp.dimensions.minHeight?.value ?? 0, heightSource: interp.dimensions.height?.source ?? "brak" });
  }
  return out;
}

function insideRing(ring, x, y) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[j];
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) hit = !hit;
  }
  return hit;
}

const unit = (dx, dy) => { const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };

export function planAllTunnels(model) {
  const cfg = model.profile.tunnels, byId = new Map(), issues = [], cuts = [];
  const stats = { tunnels: 0, passages: 0, culverts: 0, tagClearance: 0, profileClearance: 0, portals: 0, joints: 0, cuts: 0 };
  const members = [...model.states.values()].filter((state) => tunnelKind(state));
  let buildings = null;
  const refAt = new Map();
  for (const state of members) state.feature.nodeRefs.forEach((ref, i) => { if (!refAt.has(ref)) refAt.set(ref, []); refAt.get(ref).push({ state, i }); });

  // Kierunek sąsiedniego odcinka tunelu w węźle: tuby kolejnych dróg OSM łączą się bez szczeliny i bez portalu.
  const neighbour = (state, ref) => {
    const others = (refAt.get(ref) ?? []).filter((o) => o.state !== state);
    if (others.length !== 1) return { joint: others.length > 0, point: null };
    const { state: other, i } = others[0], refs = other.feature.nodeRefs, pts = other.feature.points, k = other.feature.nodeIndex[i];
    if (i !== 0 && i !== refs.length - 1) return { joint: true, point: null };
    const next = i === 0 ? k + 1 : k - 1;
    return { joint: true, point: [pts[next * 3], pts[next * 3 + 1]] };
  };

  for (const state of members) {
    const kind = tunnelKind(state), def = state.interp.classDef, tags = state.tagsNow, points = state.feature.points, n = points.length / 3;
    if (n < 2) continue;
    const group = cfg.groups[def.group] ?? cfg.fallback;
    const issue = (code, message, reason, key) => issues.push({ key: `${code}:${state.feature.id}:${key}`, code, category: "uncertain", status: "informacja", severity: 1, confidence: "wysoka", message, reason, objects: [state.feature.id], location: [points[0], points[1], points[2] ?? 0], suggest: [{ key, reason: "Wymiar z tagu zastępuje założenie profilu.", doc: `https://wiki.openstreetmap.org/wiki/Key:${key}` }] });

    let clearance = null;
    for (const key of CLEARANCE_KEYS) {
      if (tags[key] === undefined || clearance) continue;
      const value = parseMeters(tags[key]);
      if (value !== null && value > 0) clearance = { value, source: `tag ${key}`, approximate: false };
      else if (!CLEARANCE_WORDS.has(tags[key])) issue("tunnel-value", `Nieprawidłowa wartość ${key}=${tags[key]}.`, "Wartość nie jest wysokością w metrach, więc przyjęto prześwit z profilu.", key);
    }
    clearance ??= { value: group.clearance, source: `założenie profilu dla grupy ${def.group}`, approximate: true };
    stats[clearance.approximate ? "profileClearance" : "tagClearance"] += 1;
    // Strop nie może przebić obiektu nad tunelem: model poziomów zapewnia tylko ten odstęp.
    const roomAbove = model.profile.vertical.layerStepMeters - cfg.slabMeters - 0.2;
    if (state.level?.lifted && clearance.value > roomAbove) clearance = { value: roomAbove, source: `${clearance.source}; ograniczone do odstępu poziomów ${model.profile.vertical.layerStepMeters} m`, approximate: true };

    if (kind === "passage") {
      // Przejście jest wnętrzem budynku: prześwit i strop mieszczą się pod jego najniższą częścią nad osią.
      buildings ??= buildingRings(model);
      let lowest = null;
      for (let k = 0; k < n; k += 1) {
        const x = k < n - 1 ? (points[k * 3] + points[k * 3 + 3]) / 2 : points[k * 3], y = k < n - 1 ? (points[k * 3 + 1] + points[k * 3 + 4]) / 2 : points[k * 3 + 1];
        // Budynek z min_height wisi nad przejściem: wtedy miejscem jest wysokość jego spodu, a nie dachu.
        // Punkt poza prostokątem obrysu nie leży w obrysie (szybki test przed pełnym sprawdzeniem).
        for (const b of buildings) { if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue; const room = b.minHeight > 0 ? b.minHeight : b.height; if (room !== null && insideRing(b.ring, x, y) && (!lowest || room < lowest.room)) lowest = { ...b, room }; }
      }
      const room = lowest && lowest.room - cfg.slabMeters - 0.1;
      if (room !== null && room > 0 && clearance.value > room) clearance = { value: +room.toFixed(2), source: `${clearance.source}; ograniczone wysokością budynku ${lowest.id} (${lowest.height} m, ${lowest.heightSource})`, approximate: true };
    }
    const routeWidth = state.interp.dimensions.width?.value ?? def.widthMeters ?? 2;
    const width = { value: routeWidth + 2 * group.sideMargin, source: `szerokość trasy ${routeWidth} m i po ${group.sideMargin} m z każdej strony (założenie profilu)`, approximate: true };

    const z = state.level?.z ?? Float32Array.from({ length: n }, (_, i) => points[i * 3 + 2] ?? 0);
    let floor, floorSource;
    if (kind === "culvert" && !state.level?.lifted) {
      // Woda w przepuście nie płynie pod górę: posadzka leży na wysokości niższego wlotu.
      floor = new Float32Array(n).fill(Math.min(z[0], z[n - 1]));
      floorSource = { value: +floor[0].toFixed(2), source: "wysokość niższego wlotu z NMT", approximate: true };
    } else {
      floor = Float32Array.from(z);
      floorSource = { value: +Math.min(...floor).toFixed(2), source: state.level?.lifted ? "poziom tunelu z modelu poziomów" : "poziom trasy", approximate: !state.level?.reliable };
    }

    const refs = state.feature.nodeRefs, start = neighbour(state, refs[0]), end = neighbour(state, refs[refs.length - 1]);
    const portals = { start: !start.joint, end: !end.joint };
    stats.portals += Number(portals.start) + Number(portals.end); stats.joints += Number(start.joint) + Number(end.joint);

    // Wiersze tuby w wierzchołkach osi: normalna na dwusiecznej i mnożnik ścięcia, aby szerokość była stała.
    const rows = [];
    let along = 0;
    for (let k = 0; k < n; k += 1) {
      const x = points[k * 3], y = points[k * 3 + 1];
      if (k) along += Math.hypot(x - points[k * 3 - 3], y - points[k * 3 - 2]);
      const prev = k > 0 ? [points[k * 3 - 3], points[k * 3 - 2]] : start.point, next = k < n - 1 ? [points[k * 3 + 3], points[k * 3 + 4]] : end.point;
      const tin = prev ? unit(x - prev[0], y - prev[1]) : null, tout = next ? unit(next[0] - x, next[1] - y) : null;
      const t = tin && tout ? unit(tin[0] + tout[0], tin[1] + tout[1]) : tin ?? tout;
      const own = tin ?? tout, cos = Math.max(1 / MAX_MITER, t[0] * own[0] + t[1] * own[1]);
      rows.push({ s: along, x, y, tx: t[0], ty: t[1], nx: -t[1], ny: t[0], scale: tin && tout ? 1 / cos : 1, z: floor[k] });
    }

    const inner = width.value / 2, half = inner + cfg.wallMeters, top = clearance.value + cfg.slabMeters + cfg.cutBelowMeters;
    const own = [];
    for (let k = 1; k < n; k += 1) {
      const a = rows[k - 1], b = rows[k], [dx, dy] = unit(b.x - a.x, b.y - a.y), length = Math.hypot(b.x - a.x, b.y - a.y);
      // Wewnętrzne końce odcinków wchodzą na siebie, aby załamanie osi nie zostawiło klina terenu w tubie.
      const extA = k > 1 || !portals.start ? half : 0, extB = k < n - 1 || !portals.end ? half : 0, grade = (b.z - a.z) / (length || 1);
      own.push({ ax: a.x - dx * extA, ay: a.y - dy * extA, bx: b.x + dx * extB, by: b.y + dy * extB, za: a.z - grade * extA - cfg.cutBelowMeters, zb: b.z + grade * extB - cfg.cutBelowMeters, top, half });
    }
    cuts.push(...own);
    stats[kind === "passage" ? "passages" : kind === "culvert" ? "culverts" : "tunnels"] += 1;
    byId.set(state.feature.id, {
      id: state.feature.id, kind, label: labelOf(kind, tags), clearance: clearance.value, width: width.value, wall: cfg.wallMeters, slab: cfg.slabMeters, cutBelow: cfg.cutBelowMeters,
      floor, rows, portals, cuts: own, colors: cfg.colors, length: along,
      provenance: { kind: { value: labelOf(kind, tags), source: `tunnel=${tags.tunnel}`, approximate: false }, clearance, width, floor: floorSource },
    });
  }
  stats.cuts = cuts.length;
  return { byId, issues, cuts, stats };
}
