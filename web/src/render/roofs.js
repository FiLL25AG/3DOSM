// Geometria dachów według Key:roof:shape i Simple 3D Buildings, dla dowolnego obrysu (nie tylko prostokąta).
//
// Układ dachu wyznacza najmniejszy prostokąt opisany na obrysie: grzbiet biegnie wzdłuż jego dłuższego boku
// (roof:orientation=along, domyślnie) albo krótszego (across). Kształty z połaciami płaskimi są minimum (dla butterfly
// maksimum) zestawu płaszczyzn: obrys jest dzielony liniami przecięć płaszczyzn, więc każda połać jest dokładnie płaska,
// a ściana dochodzi do połaci także tam, gdzie przecina ją grzbiet lub naroże. Kształty obrotowe (pyramidal, cone, dome,
// onion) są budowane pierścieniami od obrysu do wierzchołka nad środkiem obrysu.
import * as THREE from "three";

const PLANAR = new Set(["gabled", "hipped", "half-hipped", "skillion", "saltbox", "gambrel", "mansard", "round", "butterfly"]);
const RADIAL = new Set(["pyramidal", "cone", "dome", "onion"]);
// Profil cebuli (założenie prezentacyjne): udział wysokości dachu i promień względem obrysu.
const ONION = [[0, 1], [0.15, 1.18], [0.3, 1.25], [0.45, 1.15], [0.6, 0.9], [0.75, 0.55], [0.88, 0.22], [1, 0]];

const area = (ring) => { let s = 0; for (let i = 0; i < ring.length; i += 1) { const p = ring[i], q = ring[(i + 1) % ring.length]; s += p.x * q.y - q.x * p.y; } return s / 2; };

function convexHull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y), cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of pts.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Najmniejszy prostokąt opisany: środek, oś u wzdłuż dłuższego boku (a = połowa długości) i oś v (b = połowa szerokości). */
export function orientedBox(ring) {
  const hull = convexHull(ring);
  let best = null;
  for (let i = 0; i < hull.length; i += 1) {
    const p = hull[i], q = hull[(i + 1) % hull.length], l = Math.hypot(q.x - p.x, q.y - p.y);
    if (l < 1e-6) continue;
    const ux = (q.x - p.x) / l, uy = (q.y - p.y) / l;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const h of hull) { const u = h.x * ux + h.y * uy, v = -h.x * uy + h.y * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const size = (u1 - u0) * (v1 - v0);
    if (!best || size < best.size) best = { size, ux, uy, u0, u1, v0, v1 };
  }
  if (!best) return null;
  let { ux, uy } = best, a = (best.u1 - best.u0) / 2, b = (best.v1 - best.v0) / 2;
  const cu = (best.u0 + best.u1) / 2, cv = (best.v0 + best.v1) / 2, cx = cu * ux - cv * uy, cy = cu * uy + cv * ux;
  if (b > a) { [ux, uy] = [-uy, ux]; [a, b] = [b, a]; }
  return { cx, cy, ux, uy, vx: -uy, vy: ux, a, b };
}

/** Część wielokąta (dowolnego) po stronie f ≤ 0 prostej f = A·x + B·y + C (Sutherland–Hodgman). */
function clipHalf(ring, A, B, C) {
  const out = [], f = (p) => A * p.x + B * p.y + C;
  for (let i = 0; i < ring.length; i += 1) {
    const p = ring[i], q = ring[(i + 1) % ring.length], fp = f(p), fq = f(q);
    if (fp <= 0) out.push(p);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) { const t = fp / (fp - fq); out.push(new THREE.Vector2(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t)); }
  }
  return out;
}

const clipConvex = (ring, cell) => cell.reduce((poly, line) => (poly.length ? clipHalf(poly, line.A, line.B, line.C) : poly), ring);

/** Usuwa wierzchołki leżące (niemal) w miejscu poprzedniego: ich „krawędź” ma przypadkowy kierunek i psułaby przycinanie. */
function dedupe(ring) {
  const out = [];
  for (const p of ring) if (!out.length || Math.hypot(p.x - out[out.length - 1].x, p.y - out[out.length - 1].y) > 1e-7) out.push(p);
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= 1e-7) out.pop();
  return out;
}

/**
 * Model dachu dla jednego wielokąta obrysu ([zewnętrzny, ...otwory], punkty THREE.Vector2).
 * spec: { shape, wallTop, height (null przy roof:angle), angle, direction (stopnie, 0 = północ), orientation, params }.
 * Zwraca { top(x, y), splitEdge(p, q) → punkty krawędzi ze zmianą połaci, faces: [{ vertices: [[x,y,z]…], triangles, normal|null }], height }
 * albo null, gdy dachu nie da się zbudować (wtedy płaski).
 */
export function roofModel(rings, spec) {
  const [outer] = rings;
  if (!outer || outer.length < 3) return null;
  const box = orientedBox(outer);
  if (!box) return null;
  // roof:orientation=across: grzbiet wzdłuż krótszego boku (oś u staje się dawną osią v, v jest do niej prostopadła).
  if (spec.orientation === "across") { const { ux, uy, a, b } = box; Object.assign(box, { ux: -uy, uy: ux, vx: -ux, vy: -uy, a: b, b: a }); }
  if (PLANAR.has(spec.shape)) return planarRoof(rings, box, spec);
  if (RADIAL.has(spec.shape)) return radialRoof(rings, box, spec);
  return null;
}

function heightOf(spec, span) {
  if (spec.height !== null && spec.height !== undefined) return spec.height;
  return spec.angle ? Math.tan((spec.angle * Math.PI) / 180) * span : 0;
}

/** Wektor kierunku (wschód, północ) z roof:direction albo null. */
const directionVector = (degrees) => (degrees === null || degrees === undefined ? null : [Math.sin((degrees * Math.PI) / 180), Math.cos((degrees * Math.PI) / 180)]);

function planarRoof(rings, box, spec) {
  const { a, b } = box, w = spec.wallTop, p = spec.params, [outer] = rings;
  // Płaszczyzny w układzie dachu: z = c + cx·x + cy·y (x wzdłuż grzbietu, y w poprzek).
  const planes = [];
  let mode = "min", H;
  const through = (y1, z1, y2, z2) => { const cy = (z2 - z1) / (y2 - y1); return { c: z1 - cy * y1, cx: 0, cy }; };
  const throughX = (x1, z1, x2, z2) => { const cx = (z2 - z1) / (x2 - x1); return { c: z1 - cx * x1, cx, cy: 0 }; };
  const dir = directionVector(spec.direction);
  if (spec.shape === "skillion") {
    // Połać patrzy w stronę roof:direction (najniżej z tej strony); bez kierunku: spadek w poprzek grzbietu (założenie).
    const d = dir ?? [box.vx, box.vy];
    let t0 = Infinity, t1 = -Infinity;
    for (const q of outer) { const t = q.x * d[0] + q.y * d[1]; t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
    const depth = Math.max(t1 - t0, 0.01);
    H = heightOf(spec, depth);
    const k = H / depth;
    return finishPlanar(rings, [{ A: -k * d[0], B: -k * d[1], C: w + H + k * t0 }], "min", H, spec, box);
  }
  H = heightOf(spec, b);
  const T = w + H, k = H / Math.max(b, 0.01);
  if (spec.shape === "gabled") planes.push(through(0, T, b, w), through(0, T, -b, w));
  if (spec.shape === "hipped") planes.push(through(0, T, b, w), through(0, T, -b, w), throughX(a - b, T, a, w), throughX(-(a - b), T, -a, w));
  if (spec.shape === "half-hipped") {
    // Naczółek: ściana szczytowa sięga ułamka wysokości dachu, wyżej połać naczółka (nachylenie jak połaci, założenie).
    const e = (1 - p.halfHipGableFraction) * b;
    planes.push(through(0, T, b, w), through(0, T, -b, w), { c: T + k * (a - e), cx: -k, cy: 0 }, { c: T + k * (a - e), cx: k, cy: 0 });
  }
  if (spec.shape === "saltbox") {
    // Grzbiet przesunięty: krótsza połać z tyłu (przeciwnie do roof:direction), dłuższa z przodu; bez kierunku założenie.
    const sign = dir && dir[0] * box.vx + dir[1] * box.vy < 0 ? -1 : 1, ridge = sign * b * (2 * p.saltboxShortFraction - 1);
    planes.push(through(ridge, T, -sign * b, w), through(ridge, T, sign * b, w));
  }
  if (spec.shape === "gambrel" || spec.shape === "mansard") {
    const inset = (spec.shape === "gambrel" ? p.gambrelBreakInset : p.mansardBreakInset) * b, zk = w + (spec.shape === "gambrel" ? p.gambrelBreakHeight : p.mansardBreakHeight) * H;
    for (const s of [1, -1]) planes.push(through(s * b, w, s * (b - inset), zk), through(s * (b - inset), zk, 0, T));
    if (spec.shape === "mansard") {
      const upper = (T - zk) / Math.max(b - inset, 0.01);
      for (const s of [1, -1]) planes.push(throughX(s * a, w, s * (a - inset), zk), { c: zk + upper * (a - inset), cx: -s * upper, cy: 0 });
    }
  }
  if (spec.shape === "round") {
    // Kolebka: łuk w poprzek, przybliżony cięciwami (minimum cięciw krzywej wklęsłej to łamana wpisana).
    const n = p.curveSegments;
    for (const s of [1, -1]) for (let i = 0; i < n; i += 1) {
      const f0 = (i / n) * Math.PI / 2, f1 = ((i + 1) / n) * Math.PI / 2;
      planes.push(through(s * b * Math.cos(f0), w + H * Math.sin(f0), s * b * Math.cos(f1), w + H * Math.sin(f1)));
    }
  }
  if (spec.shape === "butterfly") {
    // Motyl: okapy wysoko po bokach, kosz pośrodku; dach jest maksimum dwóch płaszczyzn.
    mode = "max";
    planes.push(through(0, w, b, T), through(0, w, -b, T));
  }
  // Płaszczyzny do układu świata: x = u·(p − c), y = v·(p − c).
  const world = planes.map(({ c, cx, cy }) => {
    const A = cx * box.ux + cy * box.vx, B = cx * box.uy + cy * box.vy;
    return { A, B, C: c - A * box.cx - B * box.cy };
  });
  return finishPlanar(rings, world, mode, H, spec, box);
}

function finishPlanar(rings, planes, mode, H, spec, box) {
  const pick = mode === "min" ? (a, b) => a < b : (a, b) => a > b;
  const valueAt = (i, x, y) => planes[i].A * x + planes[i].B * y + planes[i].C;
  const top = (x, y) => { let best = valueAt(0, x, y); for (let i = 1; i < planes.length; i += 1) { const v = valueAt(i, x, y); if (pick(v, best)) best = v; } return best; };
  // Linie zmiany połaci: przecięcia każdej pary płaszczyzn (bez równoległych i powtórzeń).
  const lines = [];
  for (let i = 0; i < planes.length; i += 1) for (let j = i + 1; j < planes.length; j += 1) {
    let A = planes[i].A - planes[j].A, B = planes[i].B - planes[j].B, C = planes[i].C - planes[j].C;
    const l = Math.hypot(A, B);
    if (l < 1e-9) continue;
    A /= l; B /= l; C /= l;
    if (!lines.some((q) => (Math.abs(q.A - A) < 1e-6 && Math.abs(q.B - B) < 1e-6 && Math.abs(q.C - C) < 1e-4) || (Math.abs(q.A + A) < 1e-6 && Math.abs(q.B + B) < 1e-6 && Math.abs(q.C + C) < 1e-4))) lines.push({ A, B, C });
  }
  // Komórki wypukłe: prostokąt dachu z zapasem dzielony kolejnymi liniami.
  const r = box.a + box.b + 2, start = [[-r, -r], [r, -r], [r, r], [-r, r]].map(([x, y]) => new THREE.Vector2(box.cx + x, box.cy + y));
  let cells = [start];
  for (const { A, B, C } of lines) {
    const next = [];
    for (const cell of cells) {
      const left = dedupe(clipHalf(cell, A, B, C)), right = dedupe(clipHalf(cell, -A, -B, -C));
      if (left.length >= 3 && Math.abs(area(left)) > 1e-8) next.push(left);
      if (right.length >= 3 && Math.abs(area(right)) > 1e-8) next.push(right);
    }
    cells = next;
  }
  // Obrys (także wklęsły, z otworami) jest najpierw dokładnie triangulowany; każdy trójkąt (wypukły) jest przycinany do
  // komórki (wypukłej), więc kawałki połaci pokrywają obrys dokładnie, bez wypełniania wcięć obrysu.
  const [ringOuter, ...ringHoles] = rings, footprint = [ringOuter, ...ringHoles].flat();
  const footprintTriangles = THREE.ShapeUtils.triangulateShape(ringOuter, ringHoles).map((tri) => tri.map((i) => footprint[i]));
  const faces = [];
  for (const cell of cells) {
    const s = area(cell) > 0 ? 1 : -1;
    const edges = cell.map((p, i) => { const q = cell[(i + 1) % cell.length], A = s * (q.y - p.y), B = s * (p.x - q.x), l = Math.hypot(A, B); return l > 1e-9 ? { A: A / l, B: B / l, C: -(A * p.x + B * p.y) / l } : null; }).filter(Boolean);
    const cxm = cell.reduce((sum, p) => sum + p.x, 0) / cell.length, cym = cell.reduce((sum, p) => sum + p.y, 0) / cell.length;
    let plane = 0;
    for (let i = 1; i < planes.length; i += 1) if (pick(valueAt(i, cxm, cym), valueAt(plane, cxm, cym))) plane = i;
    const vertices = [], triangles = [];
    for (const tri of footprintTriangles) {
      const piece = dedupe(clipConvex(tri, edges));
      if (piece.length < 3 || Math.abs(area(piece)) < 1e-6) continue;
      const base = vertices.length;
      for (const q of piece) vertices.push([q.x, q.y, valueAt(plane, q.x, q.y)]);
      for (let i = 1; i < piece.length - 1; i += 1) triangles.push([base, base + i, base + i + 1]);
    }
    if (!triangles.length) continue;
    const { A, B } = planes[plane], n = Math.hypot(A, B, 1);
    faces.push({ vertices, triangles, normal: [-A / n, -B / n, 1 / n] });
  }
  const splitEdge = (p, q) => {
    const ts = [0, 1];
    for (const { A, B, C } of lines) {
      const fp = A * p.x + B * p.y + C, fq = A * q.x + B * q.y + C;
      if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) ts.push(fp / (fp - fq));
    }
    return [...new Set(ts)].sort((x, y) => x - y).map((t) => new THREE.Vector2(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t));
  };
  return { top, splitEdge, faces, height: H };
}

function radialRoof(rings, box, spec) {
  const [outer] = rings, w = spec.wallTop;
  // Wierzchołek nad środkiem ciężkości obrysu; gdy leży poza obrysem (obrys mocno wklęsły), dach nie jest budowany.
  let sx = 0, sy = 0, s2 = 0;
  for (let i = 0; i < outer.length; i += 1) { const p = outer[i], q = outer[(i + 1) % outer.length], c = p.x * q.y - q.x * p.y; sx += (p.x + q.x) * c; sy += (p.y + q.y) * c; s2 += c; }
  if (Math.abs(s2) < 1e-6) return null;
  const apex = new THREE.Vector2(sx / (3 * s2), sy / (3 * s2));
  if (!inside(outer, apex.x, apex.y)) return null;
  const H = heightOf(spec, Math.min(box.a, box.b));
  // Pierścienie (udział promienia s, udział wysokości z) od okapu do szczytu.
  let profile;
  if (spec.shape === "pyramidal" || spec.shape === "cone") profile = [[1, 0], [0, 1]];
  else if (spec.shape === "dome") profile = Array.from({ length: spec.params.curveSegments + 1 }, (_, i) => { const f = (i / spec.params.curveSegments) * Math.PI / 2; return [Math.cos(f), Math.sin(f)]; });
  else profile = ONION.map(([z, s]) => [s, z]);
  const faces = [], ring = (s, z) => outer.map((p) => [apex.x + (p.x - apex.x) * s, apex.y + (p.y - apex.y) * s, w + H * z]);
  for (let k = 1; k < profile.length; k += 1) {
    const lower = ring(...profile[k - 1]), upper = ring(...profile[k]), vertices = [...lower, ...upper], triangles = [], n = outer.length;
    for (let i = 0; i < n; i += 1) { const j = (i + 1) % n; triangles.push([i, j, n + j], [i, n + j, n + i]); }
    faces.push({ vertices, triangles, normal: null });
  }
  return { top: () => w, splitEdge: (p, q) => [p, q], faces, height: H };
}

function inside(ring, x, y) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}
