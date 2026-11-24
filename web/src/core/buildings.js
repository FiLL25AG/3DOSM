// Części budynków (Simple 3D Buildings): gdy w obrysie budynku leżą obszary building:part, do brył 3D brane są części,
// a obrys całego budynku nie jest rysowany (pozostaje obiektem danych: wybór, diagnostyka, przejścia pod budynkiem).
import { pointInRing } from "./diagnostics.js";

const CELL = 50;
// Kontrola danych (nie zmienia rysowania): część obrysu niepokryta częściami zostaje bez bryły, więc jest zgłaszana,
// gdy przekracza ten udział pola. Pokrycie liczone próbkowaniem siatką o boku dobranym do ~400 punktów na obrys.
const UNCOVERED_REPORT_SHARE = 0.1, COVERAGE_SAMPLES = 400;

function outerRings(feature) {
  if (feature.geometry === "multipolygon") return feature.polygons.map((rings) => rings[0]);
  const ring = [];
  for (let i = 0; i < feature.points.length; i += 3) ring.push(feature.points[i], feature.points[i + 1]);
  return [ring];
}

/** Punkt wewnątrz pierścienia: środek ciężkości, a gdy wypada poza (obrys wklęsły), środek pierwszego trójkąta wachlarza, który leży w środku. */
function innerPoint(ring) {
  let sx = 0, sy = 0, s2 = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n, x0 = ring[i * 2], y0 = ring[i * 2 + 1], x1 = ring[j * 2], y1 = ring[j * 2 + 1], c = x0 * y1 - x1 * y0;
    sx += (x0 + x1) * c; sy += (y0 + y1) * c; s2 += c;
  }
  if (Math.abs(s2) > 1e-9) { const x = sx / (3 * s2), y = sy / (3 * s2); if (pointInRing(x, y, ring)) return [x, y]; }
  for (let i = 1; i < n - 1; i += 1) {
    const x = (ring[0] + ring[i * 2] + ring[i * 2 + 2]) / 3, y = (ring[1] + ring[i * 2 + 1] + ring[i * 2 + 3]) / 3;
    if (pointInRing(x, y, ring)) return [x, y];
  }
  return null;
}

/**
 * Przypisuje części budynków do obrysów, w których leżą (punkt wewnętrzny części w obrysie zewnętrznym budynku).
 * Zwraca { partsOf: obrys → [części], hidden: obrysy niepokazywane jako bryła }.
 */
export function planBuildingParts(model) {
  const outlines = [], grid = new Map();
  for (const state of model.states.values()) {
    if (state.interp.classId !== "building.main" || state.interp.geometry !== "area") continue;
    for (const ring of outerRings(state.feature)) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < ring.length; i += 2) { x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); y0 = Math.min(y0, ring[i + 1]); y1 = Math.max(y1, ring[i + 1]); }
      const entry = { id: state.feature.id, ring };
      outlines.push(entry);
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i += 1) for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j += 1) {
        const key = `${i}:${j}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(entry);
      }
    }
  }
  const partsOf = new Map();
  for (const state of model.states.values()) {
    if (state.interp.classId !== "building.part" || state.interp.geometry !== "area") continue;
    const point = innerPoint(outerRings(state.feature)[0]);
    if (!point) continue;
    for (const entry of grid.get(`${Math.floor(point[0] / CELL)}:${Math.floor(point[1] / CELL)}`) ?? []) {
      if (entry.id === state.feature.id || !pointInRing(point[0], point[1], entry.ring)) continue;
      if (!partsOf.has(entry.id)) partsOf.set(entry.id, []);
      if (!partsOf.get(entry.id).includes(state.feature.id)) partsOf.get(entry.id).push(state.feature.id);
    }
  }
  const issues = [], byId = new Map(outlines.map((e) => [e.id, []]));
  for (const e of outlines) byId.get(e.id).push(e.ring);
  for (const [id, parts] of partsOf) {
    const share = uncoveredShare(byId.get(id), parts.flatMap((part) => outerRings(model.states.get(part).feature)));
    if (share < UNCOVERED_REPORT_SHARE) continue;
    const ring = byId.get(id)[0];
    issues.push({ key: `building-parts-gap:${id}`, code: "building-parts-gap", category: "uncertain", status: "informacja", severity: 1, confidence: "średnia", message: `Części building:part pokrywają ok. ${Math.round((1 - share) * 100)}% obrysu budynku; reszta obrysu nie ma bryły 3D.`, reason: "Simple 3D Buildings: gdy budynek ma części, bryłami są tylko części, a obrys nie jest rysowany.", objects: [id, ...parts], location: [...innerPoint(ring) ?? [ring[0], ring[1]], 0], suggest: [{ key: "building:part", reason: "Części powinny pokrywać cały obrys budynku.", doc: "https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings" }] });
  }
  return { partsOf, hidden: new Set(partsOf.keys()), issues };
}

/** Udział pola obrysu (pierścienie zewnętrzne) niepokryty żadnym pierścieniem części, z próbkowania siatką. */
function uncoveredShare(rings, partRings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of rings) for (let i = 0; i < ring.length; i += 2) { x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); y0 = Math.min(y0, ring[i + 1]); y1 = Math.max(y1, ring[i + 1]); }
  const step = Math.max(0.25, Math.sqrt(((x1 - x0) * (y1 - y0)) / COVERAGE_SAMPLES));
  let inside = 0, uncovered = 0;
  for (let x = x0 + step / 2; x < x1; x += step) for (let y = y0 + step / 2; y < y1; y += step) {
    if (!rings.some((ring) => pointInRing(x, y, ring))) continue;
    inside += 1;
    if (!partRings.some((ring) => pointInRing(x, y, ring))) uncovered += 1;
  }
  return inside ? uncovered / inside : 0;
}
