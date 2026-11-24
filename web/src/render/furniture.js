// Bryły infrastruktury z OSM: latarnie i maszty oświetleniowe, słupy i przewody linii energetycznych, linie i wyposażenie
// boisk oraz tory bieżni. Wymiary nieopisane tagami są założeniami profilu (profile.furniture, profile.sports).
import * as THREE from "three";
import { orientedBox } from "./roofs.js";

export const POWER_LINE = "line.power";
export const LAMP = "point.lamp";
export const FLOODLIGHT = "point.floodlight";
export const POLE = "point.pole";
export const PITCH = "land.pitch";
export const TRACK = "land.track";
export const ENTRANCE = "point.entrance";

const color = new THREE.Color();
const rgb = (hex) => { color.setStyle(hex, THREE.LinearSRGBColorSpace); return [color.r, color.g, color.b]; };
const CARDINAL = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
// Siatka indeksów pomocniczych (jezdnie przy latarniach, boiska przy masztach).
const INDEX_CELL = 40;
// Kroki: odcinki krzywej zwisu przewodu i próbkowanie terenu pod liniami boiska.
const WIRE_STEPS = 14, MARK_STEP_METERS = 2, MARK_LIFT_METERS = 0.03;
// Najkrótszy rysowany odcinek linii toru (punkty co 1 m).
const MIN_LANE_RUN_METERS = 3;

const number = (raw) => { const m = /^\s*(\d+(?:[.,]\d+)?)\s*(m)?\s*$/.exec(raw ?? ""); return m ? Number(m[1].replace(",", ".")) : null; };
const maxVoltage = (raw) => Math.max(0, ...String(raw ?? "").split(";").map(Number).filter(Number.isFinite));

/** Kierunki z tagu (stopnie od północy zgodnie z ruchem wskazówek albo N, NE…; kilka wartości po ;) jako wektory. */
export function directionsOf(raw) {
  if (!raw) return [];
  return String(raw).split(";").map((part) => {
    const p = part.trim().toUpperCase(), deg = CARDINAL[p] ?? (/^-?\d+(\.\d+)?$/.test(p) ? Number(p) : null);
    if (deg === null) return null;
    const a = (deg * Math.PI) / 180;
    return [Math.sin(a), Math.cos(a)];
  }).filter(Boolean);
}

/** Prostopadłościan: podstawa w (x, y, z0), wysokość h, oś długa (ux, uy) o półdługości hu, półszerokość hv; `top` zwęża górę. */
export function box(sv, b, x, y, z0, h, ux, uy, hu, hv, col, pick, top = 1) {
  const vx = -uy, vy = ux, corner = (su, sv2, k) => [x + ux * su * hu * k + vx * sv2 * hv * k, y + uy * su * hu * k + vy * sv2 * hv * k];
  const lo = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => [...corner(a, c, 1), z0]);
  const hi = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => [...corner(a, c, top), z0 + h]);
  const quad = (p, normal, ao) => { const s = b.count; p.forEach((q, i) => sv(b, q[0], q[1], q[2], normal, col, pick, ao[i])); b.index.push(s, s + 1, s + 2, s, s + 2, s + 3); };
  quad([hi[0], hi[1], hi[2], hi[3]], [0, 0, 1], [1, 1, 1, 1]);
  quad([lo[3], lo[2], lo[1], lo[0]], [0, 0, -1], [0.6, 0.6, 0.6, 0.6]);
  const sides = [[0, 1, [-vx, -vy]], [1, 2, [ux, uy]], [2, 3, [vx, vy]], [3, 0, [-ux, -uy]]];
  for (const [i, j, n] of sides) quad([lo[i], lo[j], hi[j], hi[i]], [n[0], n[1], 0], [0.7, 0.7, 1, 1]);
}

/** Belka o przekroju kwadratowym (półbok `half`) między punktami p i q w 3D. */
export function beam(sv, b, p, q, half, col, pick) {
  const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], l = Math.hypot(...d);
  if (l < 1e-6) return;
  const t = d.map((v) => v / l), ref = Math.abs(t[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const n1 = norm(cross(t, ref)), n2 = cross(t, n1);
  const at = (o, a, c) => [o[0] + (n1[0] * a + n2[0] * c) * half, o[1] + (n1[1] * a + n2[1] * c) * half, o[2] + (n1[2] * a + n2[2] * c) * half];
  const ring = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (let i = 0; i < 4; i += 1) {
    const [a0, c0] = ring[i], [a1, c1] = ring[(i + 1) % 4], n = norm([n1[0] * (a0 + a1) + n2[0] * (c0 + c1), n1[1] * (a0 + a1) + n2[1] * (c0 + c1), n1[2] * (a0 + a1) + n2[2] * (c0 + c1)]);
    const s = b.count;
    for (const v of [at(p, a0, c0), at(q, a0, c0), at(q, a1, c1), at(p, a1, c1)]) sv(b, v[0], v[1], v[2], n, col, pick, 0.9);
    b.index.push(s, s + 1, s + 2, s, s + 2, s + 3);
  }
}
const cross = (a, c) => [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]];
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };

/** Przewód: krzywa zwisu (parabola) między punktami zawieszenia; zwis w środku przęsła = sagFraction × rozpiętość. */
export function catenary(a, c, sagFraction, steps = WIRE_STEPS) {
  const span = Math.hypot(c[0] - a[0], c[1] - a[1]), sag = span * sagFraction, out = [];
  for (let k = 0; k <= steps; k += 1) {
    const t = k / steps;
    out.push([a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t - 4 * sag * t * (1 - t)]);
  }
  return out;
}

function pushWire(b, points, pick) {
  for (let k = 0; k < points.length; k += 1) {
    b.push("position", ...points[k]); b.push("aPick", ...pick); b.push("aRange", b.range);
    if (k) b.index.push(b.count - 1, b.count);
    b.count += 1;
  }
}

/**
 * Indeks linii napowietrznych: słupy (power=pole/tower) z liniami, które przez nie przechodzą, i punkty zawieszenia
 * przewodów każdej linii na każdym słupie. Poprzecznik leży prostopadle do dwusiecznej kierunków linii w słupie, więc
 * przewody obu przęseł przy słupie trafiają w te same punkty, także na słupie kątowym.
 */
export function powerIndex(model, groundAt) {
  const cfg = model.profile.furniture.power, supports = new Map(), lines = new Map();
  for (const state of model.states.values()) {
    const t = state.tagsNow;
    if (state.interp.classId !== POLE || !["pole", "tower"].includes(t.power) || !state.feature.point) continue;
    const [x, y, z] = state.feature.point;
    supports.set(state.feature.osmId, { state, x, y, ground: groundAt?.(x, y) ?? z, tower: t.power === "tower", height: number(t.height), lines: [], voltage: 0 });
  }
  for (const state of model.states.values()) {
    if (state.interp.classId !== POWER_LINE || state.feature.geometry !== "way") continue;
    const f = state.feature, refs = f.nodeRefs ?? [], idx = f.nodeIndex ?? refs.map((_, i) => i), p = f.points;
    const node = (k) => [p[idx[k] * 3], p[idx[k] * 3 + 1]];
    const cables = Math.min(cfg.maxCables, Math.max(1, Math.round(number(state.tagsNow.cables) ?? cfg.defaultCables)));
    const stops = [], voltage = maxVoltage(state.tagsNow.voltage);
    for (let k = 0; k < refs.length; k += 1) {
      const sup = supports.get(refs[k]);
      if (!sup) continue;
      const here = node(k), prev = k > 0 ? node(k - 1) : null, next = k + 1 < refs.length ? node(k + 1) : null;
      let dx = 0, dy = 0;
      for (const [a, c] of [[prev, here], [here, next]]) if (a && c) { const l = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1; dx += (c[0] - a[0]) / l; dy += (c[1] - a[1]) / l; }
      const l = Math.hypot(dx, dy) || 1;
      stops.push({ sup, k, dx: dx / l, dy: dy / l });
      sup.lines.push(state.feature.id);
      sup.voltage = Math.max(sup.voltage, voltage);
    }
    lines.set(state.feature.id, { state, stops, cables, voltage });
  }
  // Układ słupa: kratowy dla napięć przesyłowych (albo power=tower bez znanego napięcia), żerdź dla dystrybucyjnych.
  for (const sup of supports.values()) {
    sup.transmission = sup.voltage > cfg.distributionMaxVoltage || (sup.tower && sup.voltage === 0);
    const design = sup.transmission ? cfg.tower : cfg.pole;
    sup.top = sup.ground + (sup.height ?? design.heightMeters);
    sup.lines.sort();
  }
  /** Punkty zawieszenia przewodów linii `lineId` na słupie (kolejno dla przewodów 0…n−1). */
  const attachments = (sup, stop, cables, lineId) => {
    const px = -stop.dy, py = stop.dx, h = sup.top - sup.ground, out = [];
    if (!sup.transmission) {
      const slot = sup.lines.indexOf(lineId), z = sup.top - 0.3 - slot * 1.2;
      for (let i = 0; i < cables; i += 1) { const o = (i - (cables - 1) / 2) * cfg.pole.spacingMeters; out.push([sup.x + px * o, sup.y + py * o, z]); }
      return out;
    }
    // Słup kratowy: trzy poziomy po obu stronach (6 przewodów) albo po jednej (3 przewody; druga linia na słupie: druga strona).
    const levels = cfg.tower.levels, arms = cfg.tower.armMeters, perSide = levels.length, slot = sup.lines.indexOf(lineId);
    for (let i = 0; i < cables; i += 1) {
      const side = cables > perSide ? (i < perSide ? -1 : 1) : (slot % 2 ? 1 : -1), level = i % perSide;
      const o = side * arms[level % arms.length];
      out.push([sup.x + px * o, sup.y + py * o, sup.ground + h * levels[level]]);
    }
    return out;
  };
  return { supports, lines, attachments, cfg };
}

export class Furniture {
  constructor(features) {
    this.features = features;
    this.model = features.model;
  }

  get sv() { return (b, x, y, z, n, col, pick, ao) => this.features._solidVertex(b, x, y, z, n, col, pick, ao); }
  ground(x, y, fallback) { const g = this.features.groundAt?.(x, y); return Number.isFinite(g) ? g : fallback; }

  /** Indeks odcinków jezdni (klasy z carriageway) do kierowania wysięgników latarni nad drogę. */
  _roads() {
    if (this.roadGrid) return this.roadGrid;
    const grid = new Map();
    for (const state of this.model.states.values()) {
      if (!state.interp.classDef.carriageway || state.feature.geometry !== "way" || state.interp.geometry !== "line") continue;
      const p = state.feature.points;
      for (let i = 3; i < p.length; i += 3) {
        const seg = [p[i - 3], p[i - 2], p[i], p[i + 1]];
        for (let gx = Math.floor(Math.min(seg[0], seg[2]) / INDEX_CELL); gx <= Math.floor(Math.max(seg[0], seg[2]) / INDEX_CELL); gx += 1) for (let gy = Math.floor(Math.min(seg[1], seg[3]) / INDEX_CELL); gy <= Math.floor(Math.max(seg[1], seg[3]) / INDEX_CELL); gy += 1) {
          const key = `${gx}:${gy}`;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(seg);
        }
      }
    }
    return (this.roadGrid = grid);
  }

  /** Kierunek od punktu do najbliższej osi jezdni w promieniu `reach` albo null. */
  towardRoad(x, y, reach) {
    const grid = this._roads();
    let best = null;
    for (let gx = Math.floor((x - reach) / INDEX_CELL); gx <= Math.floor((x + reach) / INDEX_CELL); gx += 1) for (let gy = Math.floor((y - reach) / INDEX_CELL); gy <= Math.floor((y + reach) / INDEX_CELL); gy += 1) {
      for (const [ax, ay, bx, by] of grid.get(`${gx}:${gy}`) ?? []) {
        const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1e-9)));
        const qx = ax + dx * t - x, qy = ay + dy * t - y, d = Math.hypot(qx, qy);
        if (d <= reach && d > 0.2 && (!best || d < best.d)) best = { d, v: [qx / d, qy / d] };
      }
    }
    return best?.v ?? null;
  }

  /** Środek najbliższego boiska w promieniu `reach` (kierunek opraw masztu oświetleniowego) albo null. */
  towardPitch(x, y, reach) {
    this.pitchCentres ??= [...this.model.states.values()].filter((s) => s.interp.classId === PITCH && s.feature.points).map((s) => {
      const p = s.feature.points; let cx = 0, cy = 0; const n = p.length / 3;
      for (let i = 0; i < p.length; i += 3) { cx += p[i]; cy += p[i + 1]; }
      return [cx / n, cy / n];
    });
    let best = null;
    for (const [cx, cy] of this.pitchCentres) { const d = Math.hypot(cx - x, cy - y); if (d < reach && d > 1 && (!best || d < best.d)) best = { d, v: [(cx - x) / d, (cy - y) / d] }; }
    return best?.v ?? null;
  }

  invalidate() { this.roadGrid = null; this.pitchCentres = null; this.power = null; this.facades = null; }

  /** Indeks krawędzi obrysów budynków (i części) do osadzania drzwi na licu. */
  _facades() {
    if (this.facades) return this.facades;
    const grid = new Map();
    for (const state of this.model.states.values()) {
      if (!state.interp.classId.startsWith("building") || state.interp.geometry !== "area" || state.feature.geometry === "point") continue;
      const f = state.feature, rings = f.geometry === "multipolygon" ? f.polygons.flat() : [(() => { const r = []; for (let i = 0; i < f.points.length; i += 3) r.push(f.points[i], f.points[i + 1]); return r; })()];
      for (const ring of rings) for (let i = 2; i < ring.length; i += 2) {
        const seg = { ax: ring[i - 2], ay: ring[i - 1], bx: ring[i], by: ring[i + 1], rings };
        for (let gx = Math.floor(Math.min(seg.ax, seg.bx) / INDEX_CELL); gx <= Math.floor(Math.max(seg.ax, seg.bx) / INDEX_CELL); gx += 1) for (let gy = Math.floor(Math.min(seg.ay, seg.by) / INDEX_CELL); gy <= Math.floor(Math.max(seg.ay, seg.by) / INDEX_CELL); gy += 1) {
          const key = `${gx}:${gy}`;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(seg);
        }
      }
    }
    return (this.facades = grid);
  }

  /** Lico budynku przy punkcie: rzut na najbliższą krawędź obrysu (do `reach`), kierunek krawędzi i normalna na zewnątrz. */
  facadeAt(x, y, reach) {
    let best = null;
    for (const seg of this._facades().get(`${Math.floor(x / INDEX_CELL)}:${Math.floor(y / INDEX_CELL)}`) ?? []) {
      const dx = seg.bx - seg.ax, dy = seg.by - seg.ay, l2 = dx * dx + dy * dy;
      if (l2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((x - seg.ax) * dx + (y - seg.ay) * dy) / l2)), px = seg.ax + dx * t, py = seg.ay + dy * t, d = Math.hypot(x - px, y - py);
      if (d <= reach && (!best || d < best.d)) best = { d, seg, px, py };
    }
    if (!best) return null;
    const { seg } = best, l = Math.hypot(seg.bx - seg.ax, seg.by - seg.ay), ux = (seg.bx - seg.ax) / l, uy = (seg.by - seg.ay) / l;
    let nx = -uy, ny = ux, inside = false;
    for (const r of seg.rings) if (insideRing(best.px + nx * 0.3, best.py + ny * 0.3, r)) inside = !inside;
    if (inside) { nx = -nx; ny = -ny; }
    return { px: best.px, py: best.py, ux, uy, nx, ny };
  }

  /**
   * Drzwi wejścia (Key:entrance, Key:door) na licu budynku: ościeżnica i skrzydła według rodzaju wejścia, typ z door.
   * Wymiary: width, height, door:wings z tagów, inaczej z rodzaju wejścia w profilu; level podnosi drzwi o kondygnacje.
   * Zwraca false, gdy przy węźle nie ma lica budynku (pokazywany jest wtedy znacznik).
   */
  door(state, b, pick) {
    const cfg = this.model.profile.furniture.doors, t = state.tagsNow, [x, y, z] = state.feature.point;
    if (t.door === "trapdoor") return false;
    const face = this.facadeAt(x, y, cfg.searchMeters);
    if (!face) return false;
    const kind = cfg.kinds[t.entrance] ?? cfg.default, sv = this.sv, c = Object.fromEntries(Object.entries(cfg.colours).map(([k, v]) => [k, rgb(v)]));
    const w = number(t.width) ?? kind.width, h = number(t.height) ?? kind.height, wings = Math.round(number(t["door:wings"]) ?? kind.leaves);
    const type = cfg.doorTypes.includes(t.door) && t.door !== "yes" ? t.door : kind.door ?? "hinged";
    const level = Number.parseFloat(String(t.level ?? "0").split(";")[0]), perLevel = this.model.profile.dimensions.metersPerLevel;
    const z0 = this.ground(face.px, face.py, z) + (Number.isFinite(level) && level > 0 ? level * perLevel : 0);
    const { px, py, ux, uy, nx, ny } = face, at = (along, out) => [px + ux * along + nx * out, py + uy * along + ny * out];
    const slab = (along, out, halfW, depth, zb, height, col) => { const [cx, cy] = at(along, out + depth / 2); box(sv, b, cx, cy, zb, height, ux, uy, halfW, depth / 2, col, pick); };
    const sign = kind.sign || t.entrance === "emergency" || t.entrance === "exit";
    if (type === "revolving") {
      // Drzwi obrotowe: bęben ze szklanych paneli przed licem, daszek, w środku dwa skrzydła na krzyż.
      const r = w / 2, [cx, cy] = at(0, r * 0.7);
      for (let k = 0; k < 8; k += 1) {
        const a = (k + 0.5) * (Math.PI / 4), ex = Math.cos(a), ey = Math.sin(a);
        if (ex * nx + ey * ny < -0.4) continue;
        box(sv, b, cx + ex * r, cy + ey * r, z0, h, -ey, ex, r * Math.sin(Math.PI / 8), 0.015, c.glass, pick);
      }
      box(sv, b, cx, cy, z0 + h, 0.18, ux, uy, r + 0.05, r + 0.05, c.frame, pick);
      for (const [a, d] of [[ux, uy], [nx, ny]]) box(sv, b, cx, cy, z0, h, a, d, r * 0.95, 0.02, c.frame, pick);
      return true;
    }
    slab(0, 0, w / 2 + 0.08, 0.04, z0, h + 0.08, c.frame);
    if (sign) slab(0, 0.04, 0.18, 0.05, z0 + h + 0.15, 0.14, c.sign);
    if (type === "no") { slab(0, 0.04, w / 2, 0.01, z0, h, c.opening); return true; }
    if (type === "overhead") {
      // Brama segmentowa (garażowa): panel z poziomymi przetłoczeniami.
      slab(0, 0.04, w / 2, 0.02, z0, h, c.overhead);
      for (let k = 1; k < 5; k += 1) slab(0, 0.06, w / 2 - 0.03, 0.015, z0 + (h * k) / 5 - 0.02, 0.04, c.frame);
      return true;
    }
    const glass = type === "sliding" || kind.glass, leafCol = glass ? c.glass : c.leaf, n = Math.max(1, wings), gap = 0.02, leafW = (w - gap * (n - 1)) / n;
    for (let k = 0; k < n; k += 1) {
      const along = -w / 2 + leafW / 2 + k * (leafW + gap);
      if (type === "folding") for (const s of [-1, 1]) slab(along + (s * leafW) / 4, 0.04, leafW / 4 - 0.01, 0.025, z0, h, leafCol);
      else if (type === "sliding") slab(along + (k % 2 ? 0.02 : -0.02), 0.04 + (k % 2) * 0.02, leafW / 2, 0.02, z0, h, leafCol);
      else slab(along, 0.04, leafW / 2, 0.025, z0, h, leafCol);
      // Klamka przy krawędzi skrzydła od strony środka (przesuwne: uchwyt pionowy).
      const edge = n === 1 ? leafW / 2 - 0.1 : k < n / 2 ? leafW / 2 - 0.08 : -leafW / 2 + 0.08;
      if (type === "sliding") slab(along + edge, 0.065, 0.015, 0.03, z0 + 0.8, 0.5, c.handle);
      else slab(along + edge, 0.065, 0.06, 0.03, z0 + 1.02, 0.03, c.handle);
    }
    return true;
  }

  /** Latarnia (Tag:highway=street_lamp): słup, wysięgnik nad jezdnię albo oprawa na szczycie; support i lamp_mount z tagów. */
  lamp(state, b, pick) {
    const cfg = this.model.profile.furniture.streetLamps, t = state.tagsNow, [x, y, z] = state.feature.point, g = this.ground(x, y, z);
    const pole = rgb(cfg.colour), head = rgb(cfg.headColour), sv = this.sv, mount = t.lamp_mount, support = t.support, height = number(t.height);
    let dirs = directionsOf(t["light:direction"] ?? t.direction);
    const headAt = (hx, hy, hz, ux = 1, uy = 0) => box(sv, b, hx, hy, hz - 0.14, 0.14, ux, uy, 0.32, 0.14, head, pick);
    if (mount === "high_mast") {
      const h = height ?? cfg.highMastMeters;
      box(sv, b, x, y, g, h, 1, 0, 0.35, 0.35, pole, pick, 0.5);
      for (let k = 0; k < 4; k += 1) { const a = (k * Math.PI) / 2; headAt(x + Math.cos(a) * 0.9, y + Math.sin(a) * 0.9, g + h, Math.cos(a), Math.sin(a)); }
      return;
    }
    if (cfg.lowSupports.includes(support) || mount === "bollard") {
      const h = height ?? cfg.lowHeightMeters;
      box(sv, b, x, y, g, h, 1, 0, 0.09, 0.09, pole, pick);
      box(sv, b, x, y, g + h, 0.25, 1, 0, 0.13, 0.13, head, pick);
      return;
    }
    const onWall = cfg.wallSupports.includes(support) || mount === "wall", onOtherPole = ["straight_arm", "bent_arm"].includes(mount) || ["power_pole", "utility_pole"].includes(support);
    const hanging = mount === "suspended" || support === "wire";
    const h = height ?? (onWall ? cfg.wallHeightMeters : cfg.heightMeters), top = g + h;
    if (!onWall && !onOtherPole && !hanging) box(sv, b, x, y, g, h, 1, 0, 0.1, 0.1, pole, pick, 0.65);
    if (hanging) { headAt(x, y, top); return; }
    // Wysięgnik: kierunek z light:direction (albo direction), bez tagu w stronę najbliższej jezdni; prosty maszt: oprawa na szczycie.
    if (!dirs.length && mount !== "straight_mast") { const road = this.towardRoad(x, y, cfg.roadSearchMeters); if (road) dirs = [road]; }
    if (mount === "straight_mast" || !dirs.length) { box(sv, b, x, y, top, 0.3, 1, 0, 0.16, 0.16, head, pick); return; }
    const arm = onWall ? 0.6 : cfg.armMeters;
    for (const [dx, dy] of dirs) {
      beam(sv, b, [x, y, top - 0.15], [x + dx * arm, y + dy * arm, top + 0.1], 0.04, pole, pick);
      headAt(x + dx * (arm + 0.25), y + dy * (arm + 0.25), top + 0.05, dx, dy);
    }
  }

  /** Maszt oświetleniowy (tower:type=lighting): maszt i panel opraw zwrócony w stronę najbliższego boiska. */
  floodlight(state, b, pick) {
    const cfg = this.model.profile.furniture.floodlights, [x, y, z] = state.feature.point, g = this.ground(x, y, z), h = number(state.tagsNow.height) ?? cfg.heightMeters;
    box(this.sv, b, x, y, g, h, 1, 0, 0.22, 0.22, rgb(cfg.colour), pick, 0.55);
    const [dx, dy] = this.towardPitch(x, y, 150) ?? [1, 0];
    box(this.sv, b, x + dx * 0.4, y + dy * 0.4, g + h - 0.9, 1.4, -dy, dx, 1.3, 0.2, rgb(cfg.headColour), pick);
  }

  _power() { return (this.power ??= powerIndex(this.model, this.features.groundAt)); }

  /** Słup linii energetycznej: żerdź z poprzecznikami albo słup kratowy (zwężający się trzon i ramiona na poziomach). */
  support(state, b, wires, pick) {
    const index = this._power(), sup = index.supports.get(state.feature.osmId);
    if (!sup) return false;
    const cfg = index.cfg, sv = this.sv, t = state.tagsNow, h = sup.top - sup.ground;
    const stopsHere = sup.lines.map((id) => { const line = index.lines.get(id); return { id, line, stop: line.stops.find((s) => s.sup === sup) }; });
    const first = stopsHere[0]?.stop ?? { dx: 1, dy: 0 };
    if (sup.transmission) {
      box(sv, b, sup.x, sup.y, sup.ground, h, first.dx, first.dy, 2.6, 2.6, rgb(cfg.tower.colour), pick, 0.2);
      cfg.tower.levels.forEach((f, level) => {
        const arm = cfg.tower.armMeters[level % cfg.tower.armMeters.length] + 0.4, z = sup.ground + h * f + 0.3;
        beam(sv, b, [sup.x - first.dy * arm, sup.y + first.dx * arm, z], [sup.x + first.dy * arm, sup.y - first.dx * arm, z], 0.35, rgb(cfg.tower.colour), pick);
      });
    } else {
      box(sv, b, sup.x, sup.y, sup.ground, h, first.dx, first.dy, 0.2, 0.15, rgb(cfg.pole.colour), pick, 0.6);
      for (const { line, stop } of stopsHere) {
        const points = index.attachments(sup, stop, line.cables, line.state.feature.id), a = points[0], c = points.at(-1), dx = c[0] - a[0], dy = c[1] - a[1], l = Math.hypot(dx, dy) || 1;
        beam(sv, b, [a[0] - (dx / l) * 0.25, a[1] - (dy / l) * 0.25, a[2] - 0.12], [c[0] + (dx / l) * 0.25, c[1] + (dy / l) * 0.25, c[2] - 0.12], 0.06, rgb(cfg.pole.colour), pick);
      }
      // Transformator słupowy (tag transformer): skrzynia na słupie poniżej przewodów.
      if (t.transformer) box(sv, b, sup.x - first.dy * 0.7, sup.y + first.dx * 0.7, sup.top - 4.6, 1.4, first.dx, first.dy, 0.6, 0.45, rgb(cfg.transformerColour), pick);
    }
    // Przejście w kabel (location:transition=yes): przewody schodzą po słupie do ziemi.
    if (t["location:transition"] === "yes") {
      for (const { line, stop } of stopsHere) {
        for (const p of index.attachments(sup, stop, line.cables, line.state.feature.id)) {
          const ox = (p[0] - sup.x) * 0.25, oy = (p[1] - sup.y) * 0.25;
          pushWire(wires, [p, [sup.x + ox, sup.y + oy, p[2] - 1], [sup.x + ox + 0.25, sup.y + oy, sup.ground]], pick);
        }
      }
    }
    return true;
  }

  /** Przewody linii napowietrznej: krzywe zwisu między odpowiadającymi sobie punktami zawieszenia kolejnych słupów. */
  powerLine(state, wires, pick) {
    const index = this._power(), line = index.lines.get(state.feature.id);
    if (!line) return;
    for (let k = 1; k < line.stops.length; k += 1) {
      const a = line.stops[k - 1], c = line.stops[k];
      const from = index.attachments(a.sup, a, line.cables, state.feature.id), to = index.attachments(c.sup, c, line.cables, state.feature.id);
      for (let i = 0; i < line.cables; i += 1) pushWire(wires, catenary(from[i], to[i], index.cfg.sagFraction), pick);
    }
  }

  /** Linie, bramki, kosze i siatki boiska według przepisów dyscypliny, w prostokącie opisanym na obrysie. */
  pitch(state, marks, kit, pick) {
    const sports = this.model.profile.sports, sport = (state.tagsNow.sport ?? "").split(";")[0].trim(), rule = sports.pitches[sport];
    if (!rule || state.feature.geometry !== "way") return;
    const frame = pitchFrame(state.feature.points, rule, sports);
    if (!frame) return;
    const draw = drawPitch(sport, frame, rule);
    this._marks(marks, frame, draw.lines, rule.line, rgb(sports.lineColour), pick);
    this._kit(kit, frame, draw.kit, rgb(sports.equipmentColour), rgb(sports.netColour), pick);
  }

  /** Tory bieżni (trackLanes): linie równoległe do krawężnika wewnętrznego, przycięte do obszaru bieżni. */
  track(state, marks, pick) {
    const sports = this.model.profile.sports;
    for (const line of trackLanes(state.feature, state.tagsNow, sports)) this._strip(marks, line, sports.track.line, rgb(sports.lineColour), pick, false);
  }

  /** Linie na gruncie w układzie boiska (u wzdłuż, v w poprzek; metry boiska po skalowaniu). */
  _marks(b, frame, lines, width, col, pick, scaled = true) {
    for (const line of lines) this._strip(b, line.map(([u, v]) => frame.world(u, v, scaled)), width, col, pick, false);
  }

  /** Pas o szerokości `width` wzdłuż łamanej [x, y] na terenie, próbkowanej co MARK_STEP_METERS. */
  _strip(b, points, width, col, pick, closed) {
    const pts = closed ? [...points, points[0]] : points, dense = [];
    for (let i = 1; i < pts.length; i += 1) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / MARK_STEP_METERS));
      for (let k = i === 1 ? 0 : 1; k <= n; k += 1) dense.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    }
    const half = width / 2;
    for (let i = 1; i < dense.length; i += 1) {
      const [ax, ay] = dense[i - 1], [bx, by] = dense[i], l = Math.hypot(bx - ax, by - ay);
      if (l < 1e-6) continue;
      const nx = (-(by - ay) / l) * half, ny = ((bx - ax) / l) * half, za = this.ground(ax, ay, 0) + MARK_LIFT_METERS, zb = this.ground(bx, by, 0) + MARK_LIFT_METERS, s = b.count;
      for (const [x, y, z] of [[ax - nx, ay - ny, za], [bx - nx, by - ny, zb], [bx + nx, by + ny, zb], [ax + nx, ay + ny, za]]) this.features._solidVertex(b, x, y, z, [0, 0, 1], col, pick, 1);
      b.index.push(s, s + 1, s + 2, s, s + 2, s + 3);
    }
  }

  /** Wyposażenie: belki (słupki, poprzeczki) i panele siatek w układzie boiska; wysokości w metrach nad gruntem. */
  _kit(b, frame, kit, col, netCol, pick) {
    const sv = this.sv;
    for (const item of kit) {
      const [p, q] = [item.from, item.to].map(([u, v, h]) => { const [x, y] = frame.world(u, v, true); return [x, y, this.ground(x, y, 0) + h]; });
      if (item.panel) {
        // Siatka: cienki panel między dwoma punktami u dołu, wysokość item.panel.
        const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1;
        box(sv, b, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, Math.min(p[2], q[2]), item.panel, dx / l, dy / l, l / 2, 0.01, netCol, pick);
      } else beam(sv, b, p, q, item.half ?? 0.06, col, pick);
    }
  }
}

const ringArea = (r) => { let s = 0; for (let i = 0; i + 3 < r.length; i += 2) s += r[i] * r[i + 3] - r[i + 2] * r[i + 1]; return s / 2; };
const insideRing = (x, y, r) => { let c = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { const yi = r[i + 1], yj = r[j + 1]; if (yi > y !== yj > y && x < ((r[j] - r[i]) * (y - yi)) / (yj - yi) + r[i]) c = !c; } return c; };
function distanceToRing(x, y, r) {
  let best = Infinity;
  for (let i = 2; i < r.length; i += 2) {
    const ax = r[i - 2], ay = r[i - 1], dx = r[i] - ax, dy = r[i + 1] - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1e-9)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/**
 * Linie torów bieżni. Tory mierzy się od krawężnika wewnętrznego (szerokość toru 1,22 m według przepisów World
 * Athletics), więc linie są równoległe do pierścienia wewnętrznego (płyty) i przycięte do obszaru bieżni: dobiegi
 * i narożniki obrysu zewnętrznego nie zaginają torów. Liczba torów: lanes, a bez tagu (tylko dyscypliny z
 * sports.track.lanedSports) z szerokości bieżni mierzonej od krawężnika do brzegu. Bieżnia bez płyty (prosta)
 * ma tory wzdłuż dłuższego boku tylko z tagu lanes.
 */
export function trackLanes(feature, tags, sports) {
  const cfg = sports.track, lanesTag = number(tags.lanes), out = [];
  const polygons = feature.geometry === "multipolygon" ? feature.polygons : [[(() => { const r = []; for (let i = 0; i < feature.points.length; i += 3) r.push(feature.points[i], feature.points[i + 1]); return r; })()]];
  for (const [outer, ...holes] of polygons) {
    if (!holes.length) {
      const frame = pitchFrame(outer.flatMap((v, i) => (i % 2 ? [v, 0] : [v])), null, sports);
      if (!frame || !(lanesTag > 1)) continue;
      for (let k = 1; k < lanesTag; k += 1) { const v = -frame.b + (2 * frame.b * k) / lanesTag; out.push([frame.world(-frame.a, v, false), frame.world(frame.a, v, false)]); }
      continue;
    }
    const kerb = holes.reduce((a, c) => (Math.abs(ringArea(c)) > Math.abs(ringArea(a)) ? c : a));
    // Szerokość: mediana odległości punktów krawężnika od obrysu zewnętrznego (dobiegi poza owalem jej nie zawyżają).
    const widths = [];
    for (let i = 0; i + 1 < kerb.length; i += 2) widths.push(distanceToRing(kerb[i], kerb[i + 1], outer));
    widths.sort((a, c) => a - c);
    const width = widths[Math.floor(widths.length / 2)] ?? 0, sport = String(tags.sport ?? "").split(";").map((s) => s.trim());
    const lanes = lanesTag ?? (sport.some((s) => cfg.lanedSports.includes(s)) ? Math.floor(width / cfg.laneMeters) : 0);
    if (!(lanes > 1) || !(width > 0)) continue;
    const lane = Math.min(cfg.laneMeters, width / lanes), outward = ringArea(kerb) > 0 ? -1 : 1;
    const inTrack = (x, y) => insideRing(x, y, outer) && !holes.some((h) => insideRing(x, y, h));
    // Linie między torami; zewnętrzny brzeg ostatniego toru to krawędź nawierzchni, więc nie jest rysowany.
    for (let k = 1; k < lanes; k += 1) {
      const ring = offsetRing(kerb, lane * k, outward), dense = [];
      for (let i = 0; i < ring.length; i += 1) {
        const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
        for (let s = 0; s < n; s += 1) dense.push([ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n]);
      }
      // Odcinki wewnątrz bieżni; przebieg przechodzący przez początek pierścienia jest łączony w jeden.
      const runs = [];
      let run = null;
      for (const p of dense) {
        if (inTrack(p[0], p[1])) { if (!run) runs.push((run = [])); run.push(p); } else run = null;
      }
      if (runs.length > 1 && inTrack(...dense[0]) && inTrack(...dense.at(-1))) runs[0] = [...runs.pop(), ...runs[0]];
      else if (runs.length === 1 && runs[0].length === dense.length) runs[0].push(dense[0]);
      // Strzępy krótsze niż MIN_LANE_RUN_METERS (linia muska brzeg) są pomijane.
      for (const r of runs) if (r.length > MIN_LANE_RUN_METERS) out.push(r);
    }
  }
  return out;
}

/** Przesunięcie pierścienia do środka/** Przesunięcie pierścienia do środka o `d` (narożniki na dwusiecznej, ze skróceniem ostrych kątów). */
export function offsetRing(ring, d, inward) {
  const pts = [];
  for (let i = 0; i < ring.length; i += 2) pts.push([ring[i], ring[i + 1]]);
  if (pts.length > 1 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1]) pts.pop();
  const n = pts.length, out = [];
  for (let i = 0; i < n; i += 1) {
    const a = pts[(i - 1 + n) % n], p = pts[i], c = pts[(i + 1) % n];
    const e1 = norm([p[0] - a[0], p[1] - a[1], 0]), e2 = norm([c[0] - p[0], c[1] - p[1], 0]);
    const n1 = [-e1[1] * inward, e1[0] * inward], n2 = [-e2[1] * inward, e2[0] * inward], m = norm([n1[0] + n2[0], n1[1] + n2[1], 0]);
    const k = Math.min(3, 1 / Math.max(0.3, m[0] * n1[0] + m[1] * n1[1]));
    out.push([p[0] + m[0] * d * k, p[1] + m[1] * d * k]);
  }
  return out;
}

/**
 * Układ boiska: prostokąt opisany na obrysie (oś u wzdłuż dłuższego boku). Zwraca null, gdy obrys nie jest prostokątny
 * (pole obrysu < minFill pola prostokąta) albo proporcje odbiegają od przepisów dyscypliny o więcej niż aspectTolerance.
 * world(u, v, scaled): punkt w metrach przepisów (scaled) albo w metrach rzeczywistych.
 */
export function pitchFrame(points, rule, sports) {
  const ring = [];
  for (let i = 0; i + 2 < points.length; i += 3) ring.push(new THREE.Vector2(points[i], points[i + 1]));
  if (ring.length > 2 && ring[0].equals(ring.at(-1))) ring.pop();
  const obb = ring.length >= 3 ? orientedBox(ring) : null;
  if (!obb) return null;
  let s2 = 0;
  for (let i = 0; i < ring.length; i += 1) { const p = ring[i], q = ring[(i + 1) % ring.length]; s2 += p.x * q.y - q.x * p.y; }
  if (Math.abs(s2) / 2 / (4 * obb.a * obb.b) < sports.minFill) return null;
  if (rule && Math.abs((obb.a / obb.b) / (rule.length / rule.width) - 1) > sports.aspectTolerance) return null;
  const sx = rule ? (2 * obb.a) / rule.length : 1, sy = rule ? (2 * obb.b) / rule.width : 1, s = Math.min(sx, sy);
  // Odległości liczone od najbliższej linii odniesienia (środek albo linia końcowa/boczna) skalują się jednakowo (s),
  // więc pole karne zostaje przy linii bramkowej, a koło na środku; linie obrysu leżą na brzegu prostokąta.
  const along = (x, half, real) => (Math.abs(x) <= half / 2 ? x * s : Math.sign(x) * (real - (half - Math.abs(x)) * s));
  return {
    ...obb, sx, sy, s,
    world(u, v, scaled = true) {
      const U = scaled && rule ? along(u, rule.length / 2, obb.a) : u, V = scaled && rule ? along(v, rule.width / 2, obb.b) : v;
      return [obb.cx + obb.ux * U + obb.vx * V, obb.cy + obb.uy * U + obb.vy * V];
    },
  };
}

const arc = (cu, cv, r, a0, a1, n = 24) => Array.from({ length: n + 1 }, (_, k) => { const a = a0 + ((a1 - a0) * k) / n; return [cu + r * Math.cos(a), cv + r * Math.sin(a)]; });
const rect = (u0, v0, u1, v1) => [[u0, v0], [u1, v0], [u1, v1], [u0, v1], [u0, v0]];

/**
 * Linie i wyposażenie według przepisów (wymiary w metrach boiska pełnowymiarowego; pitchFrame skaluje je do obrysu).
 * Piłka nożna: przepisy IFAB (pole karne 16,5 m, bramkowe 5,5 m, koło 9,15 m, bramka 7,32 × 2,44 m); tenis: ITF
 * (linie serwisowe 6,40 m od siatki, siatka 0,914 m); koszykówka: FIBA (linia 3 pkt 6,75 m, obręcz 3,05 m);
 * siatkówka: FIVB (linia ataku 3 m, siatka 2,43 m, w plażowej 16 × 8 m).
 */
export function drawPitch(sport, frame, rule) {
  const L = rule.length / 2, W = rule.width / 2, lines = [rect(-L, -W, L, W)], kit = [];
  // Wymiary bezwzględne (bramki, kosze, siatki) skalowane jak linie wewnętrzne, z dolną granicą dla małych boisk.
  const k = Math.max(frame.s, 0.5) / frame.s;
  if (sport === "soccer") {
    lines.push([[0, -W], [0, W]], arc(0, 0, 9.15, 0, Math.PI * 2, 40));
    for (const e of [-1, 1]) {
      const g = e * L;
      lines.push(rect(g, -20.16, g - e * 16.5, 20.16), rect(g, -9.16, g - e * 5.5, 9.16));
      const spot = g - e * 11, a0 = Math.acos(5.5 / 9.15);
      lines.push(e > 0 ? arc(spot, 0, 9.15, Math.PI - a0, Math.PI + a0, 12) : arc(spot, 0, 9.15, -a0, a0, 12));
      lines.push([[spot - 0.15, 0], [spot + 0.15, 0]]);
      for (const c of [-1, 1]) lines.push(arc(g, c * W, 1, e > 0 ? (c > 0 ? Math.PI : Math.PI / 2) : (c > 0 ? -Math.PI / 2 : 0), e > 0 ? (c > 0 ? Math.PI * 1.5 : Math.PI) : (c > 0 ? 0 : Math.PI / 2), 6));
      // Bramka 7,32 × 2,44 m; na małych boiskach nie mniejsza niż 3,66 × 2 m.
      const gw = 3.66 * k, h = 2.44 * Math.max(frame.s, 0.82);
      for (const c of [-1, 1]) {
        kit.push({ from: [g, c * gw, 0], to: [g, c * gw, h], half: 0.06 });
        kit.push({ from: [g, c * gw, h], to: [g + e * 1.5 * k, c * gw, 0], half: 0.03 });
      }
      kit.push({ from: [g, -gw, h], to: [g, gw, h], half: 0.06 });
    }
  } else if (sport === "tennis") {
    const singles = 4.115;
    lines.push([[-L, -singles], [L, -singles]], [[-L, singles], [L, singles]], [[-6.4, -singles], [-6.4, singles]], [[6.4, -singles], [6.4, singles]], [[-6.4, 0], [6.4, 0]], [[-L, 0], [-L + 0.1, 0]], [[L, 0], [L - 0.1, 0]]);
    const post = W + 0.914;
    for (const c of [-1, 1]) kit.push({ from: [0, c * post, 0], to: [0, c * post, 1.07], half: 0.05 });
    kit.push({ from: [0, -post, 0], to: [0, post, 0], panel: 0.914 });
    kit.push({ from: [0, -post, 0.914], to: [0, post, 0.914], half: 0.03 });
  } else if (sport === "basketball") {
    lines.push([[0, -W], [0, W]], arc(0, 0, 1.8, 0, Math.PI * 2, 32));
    for (const e of [-1, 1]) {
      const g = e * L, basket = g - e * 1.575, side = 6.6, straight = Math.sqrt(6.75 ** 2 - side ** 2);
      lines.push([[g, -side], [basket - e * straight, -side]], [[g, side], [basket - e * straight, side]]);
      const a = Math.atan2(side, -e * straight);
      lines.push(e > 0 ? arc(basket, 0, 6.75, a, 2 * Math.PI - a, 32) : arc(basket, 0, 6.75, -a, a, 32));
      lines.push(rect(g, -2.45, g - e * 5.8, 2.45), arc(g - e * 5.8, 0, 1.8, e > 0 ? Math.PI / 2 : -Math.PI / 2, e > 0 ? Math.PI * 1.5 : Math.PI / 2, 16));
      const board = g - e * 1.2;
      kit.push({ from: [g + e * 1.0, 0, 0], to: [g + e * 1.0, 0, 3.4], half: 0.08 });
      kit.push({ from: [g + e * 1.0, 0, 3.3], to: [board, 0, 3.3], half: 0.05 });
      kit.push({ from: [board, -0.9, 2.9], to: [board, 0.9, 2.9], panel: 1.05 });
      kit.push({ from: [board - e * 0.15, -0.23, 3.05], to: [board - e * 0.15, 0.23, 3.05], half: 0.02 });
      kit.push({ from: [board - e * 0.6, -0.23, 3.05], to: [board - e * 0.6, 0.23, 3.05], half: 0.02 });
      kit.push({ from: [board - e * 0.15, -0.23, 3.05], to: [board - e * 0.6, -0.23, 3.05], half: 0.02 });
      kit.push({ from: [board - e * 0.15, 0.23, 3.05], to: [board - e * 0.6, 0.23, 3.05], half: 0.02 });
    }
  } else if (sport === "volleyball" || sport === "beachvolleyball") {
    lines.push([[0, -W], [0, W]]);
    if (sport === "volleyball") lines.push([[-3, -W], [-3, W]], [[3, -W], [3, W]]);
    const post = W + 1;
    for (const c of [-1, 1]) kit.push({ from: [0, c * post, 0], to: [0, c * post, 2.55], half: 0.05 });
    kit.push({ from: [0, -W - 0.25, 1.43], to: [0, W + 0.25, 1.43], panel: 1.0 });
    kit.push({ from: [0, -W - 0.25, 2.43], to: [0, W + 0.25, 2.43], half: 0.025 });
  }
  return { lines, kit };
}
