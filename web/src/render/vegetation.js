// Roślinność 3D: drzewa i krzewy jako instancje siatek wzorcowych (vegetationMaterial). Źródła i założenia są w profilu
// (profile.vegetation): pojedyncze drzewa i szpalery z OSM oraz wypełnienie lasów i zarośli stałą siatką.
import * as THREE from "three";
import { vegetationMaterial } from "./shaders.js";

// Kwadrat instancji: wypełnienie obszaru jest liczone i rysowane kwadratami, aby kamera odrzucała niewidoczne części
// dużych lasów, a budowa rozkładała się na porcje między klatkami.
export const CELL_METERS = 250;
// Siatka indeksu tras i obszarów, które wypełnienie omija.
const CLEAR_CELL_METERS = 32;
// Próbkowanie terenu pod wypełnieniem (kafel terenu najwyższego poziomu ma 128 m).
export const GROUND_SAMPLE_METERS = 48;

/** Obrót, przesunięcie i odcień są stałe dla miejsca (hash punktu siatki), więc nie zmieniają się przy doczytywaniu. */
function hash(i, j, salt = 0) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(salt + 1, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function ringsOf(feature) {
  if (feature.geometry === "multipolygon") return feature.polygons.flat();
  const ring = [];
  for (let i = 0; i < feature.points.length; i += 3) ring.push(feature.points[i], feature.points[i + 1]);
  return [ring];
}

function pointInRings(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Wielkość obszaru do porównań (suma pól pierścieni): wystarcza, aby odróżnić polanę od lasu, w którym leży. */
function ringsArea(rings) {
  let total = 0;
  for (const ring of rings) {
    let s = 0;
    for (let i = 0; i + 3 < ring.length; i += 2) s += ring[i] * ring[i + 3] - ring[i + 2] * ring[i + 1];
    total += Math.abs(s) / 2;
  }
  return total;
}

function boxOf(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of rings) for (let i = 0; i < ring.length; i += 2) { x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); y0 = Math.min(y0, ring[i + 1]); y1 = Math.max(y1, ring[i + 1]); }
  return [x0, y0, x1, y1];
}

/**
 * Punkty siatki (krok `step`, zakotwiczonej w wielokrotnościach kroku) wewnątrz pierścieni z regułą parzystości
 * (otwory multipolygonu są puste). Wiersze są wypełniane z przecięć krawędzi, a nie testem każdego punktu.
 * `clip` [x0, y0, x1, y1) ogranicza punkty do prostokąta (kwadratu instancji).
 */
export function gridInside(rings, step, visit, clip = null) {
  let [x0, y0, x1, y1] = boxOf(rings);
  const xMin = clip ? clip[0] : -Infinity;
  if (clip) { y0 = Math.max(y0, clip[1]); y1 = Math.min(y1, clip[3] - 1e-9); x1 = Math.min(x1, clip[2] - 1e-9); }
  for (let j = Math.ceil(y0 / step); j * step <= y1; j += 1) {
    const y = j * step, xs = [];
    for (const ring of rings) {
      for (let i = 0, k = ring.length - 2; i < ring.length; k = i, i += 2) {
        const ya = ring[k + 1], yb = ring[i + 1];
        if (ya > y === yb > y) continue;
        xs.push(ring[k] + ((y - ya) * (ring[i] - ring[k])) / (yb - ya));
      }
    }
    xs.sort((a, b) => a - b);
    for (let m = 0; m + 1 < xs.length; m += 2) {
      for (let i = Math.ceil(Math.max(xs[m], xMin) / step); i * step < xs[m + 1] && i * step <= x1; i += 1) visit(i, j);
    }
  }
}

/** Prostokąty pracy dla obiektu roślinności: kwadraty instancji przecinające obszar albo cały obiekt (drzewo, szpaler). */
export function vegetationCells(state) {
  const veg = state.interp.vegetation;
  if (veg.placement !== "fill") return [null];
  if (state.interp.geometry !== "area") return [];
  const [x0, y0, x1, y1] = boxOf(ringsOf(state.feature)), out = [];
  for (let i = Math.floor(x0 / CELL_METERS); i <= Math.floor(x1 / CELL_METERS); i += 1) for (let j = Math.floor(y0 / CELL_METERS); j <= Math.floor(y1 / CELL_METERS); j += 1) out.push([i * CELL_METERS, j * CELL_METERS, (i + 1) * CELL_METERS, (j + 1) * CELL_METERS]);
  return out;
}

/** Pozycje do pobrania terenu pod roślinnością: drzewa, szpalery (wierzchołki) i siatka wewnątrz wypełnianych obszarów. */
export function vegetationGroundPositions(model, positions, lines) {
  for (const state of model.states.values()) {
    const veg = state.interp.vegetation, f = state.feature;
    if (!veg) continue;
    if (veg.placement === "point") { if (f.point) positions.push(f.point[0], f.point[1]); continue; }
    if (veg.placement === "row") { if (f.points) lines.push(f.points); continue; }
    if (state.interp.geometry !== "area") continue;
    const rings = ringsOf(f);
    for (const ring of rings) lines.push(ring.flatMap((v, i) => (i % 2 ? [v, 0] : [v])));
    gridInside(rings, GROUND_SAMPLE_METERS, (i, j) => positions.push(i * GROUND_SAMPLE_METERS, j * GROUND_SAMPLE_METERS));
  }
}

/** Indeks tras i obszarów bez drzew (profile.vegetation.clearance), z którego korzysta wypełnienie obszarów. */
export function clearanceIndex(model, widthOf) {
  const cfg = model.profile.vegetation.clearance, lineGroups = new Set(cfg.lineGroups), areaGroups = new Set(cfg.areaGroups), areaClasses = new Set(cfg.areaClasses);
  const lines = new Map(), areas = new Map();
  const add = (grid, box, item) => {
    for (let i = Math.floor(box[0] / CLEAR_CELL_METERS); i <= Math.floor(box[2] / CLEAR_CELL_METERS); i += 1) for (let j = Math.floor(box[1] / CLEAR_CELL_METERS); j <= Math.floor(box[3] / CLEAR_CELL_METERS); j += 1) {
      const key = `${i}:${j}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(item);
    }
  };
  for (const state of model.states.values()) {
    const { interp, feature } = state, def = interp.classDef;
    if (feature.geometry === "point") continue;
    if (interp.geometry === "line" && feature.geometry === "way" && lineGroups.has(def.group) && !model.tunnels?.byId.has(feature.id)) {
      const half = widthOf(state) / 2, p = feature.points;
      for (let i = 3; i < p.length; i += 3) {
        const seg = { ax: p[i - 3], ay: p[i - 2], bx: p[i], by: p[i + 1], half };
        add(lines, [Math.min(seg.ax, seg.bx) - half, Math.min(seg.ay, seg.by) - half, Math.max(seg.ax, seg.bx) + half, Math.max(seg.ay, seg.by) + half], seg);
      }
    } else if (interp.geometry === "area" && (areaGroups.has(def.group) || areaClasses.has(interp.classId))) {
      const rings = ringsOf(feature);
      // Klasy pokrycia (trawnik, piasek) blokują tylko obszary większe od siebie: polana w lesie usuwa drzewa,
      // a rabata czy ogród narysowane na trawniku zachowują rośliny. Budynki, woda i konstrukcje blokują zawsze.
      add(areas, boxOf(rings), { rings, group: def.group, size: areaGroups.has(def.group) ? Infinity : ringsArea(rings) });
    }
  }
  const key = (x, y) => `${Math.floor(x / CLEAR_CELL_METERS)}:${Math.floor(y / CLEAR_CELL_METERS)}`;
  return {
    /** Czy punkt leży w obszarze bez drzew (poza grupą `except`) albo bliżej trasy niż jej półszerokość plus zapas. */
    blocked(x, y, margin, except = null, ownSize = Infinity) {
      for (const { rings, group, size } of areas.get(key(x, y)) ?? []) if (group !== except && (size === Infinity || size < ownSize) && pointInRings(x, y, rings)) return true;
      const r = margin + 8;
      for (let i = Math.floor((x - r) / CLEAR_CELL_METERS); i <= Math.floor((x + r) / CLEAR_CELL_METERS); i += 1) for (let j = Math.floor((y - r) / CLEAR_CELL_METERS); j <= Math.floor((y + r) / CLEAR_CELL_METERS); j += 1) {
        for (const s of lines.get(`${i}:${j}`) ?? []) {
          const dx = s.bx - s.ax, dy = s.by - s.ay, t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / (dx * dx + dy * dy || 1e-9)));
          if (Math.hypot(x - s.ax - t * dx, y - s.ay - t * dy) < s.half + margin) return true;
        }
      }
      return false;
    },
  };
}

/** Forma rośliny w mieszance (udziały w profilu) wybrana hashem miejsca; bez mieszanki: forma obiektu. */
function formOf(veg, seed) {
  if (!veg.mix) return veg.form;
  const total = veg.mix.reduce((sum, m) => sum + m.share, 0);
  let acc = 0;
  for (const m of veg.mix) { acc += m.share / total; if (seed < acc) return m.form; }
  return veg.mix.at(-1).form;
}

/** Wymiary i wygląd jednego drzewa lub krzewu; `seed` to hash miejsca (odcień, obrót, wybór przy leaf_type=mixed). */
function plant(veg, cfg, seed, seed2, seed3 = 0.5) {
  const leaf = veg.leafType.value === "mixed" ? (seed2 < 0.5 ? "broadleaved" : "needleleaved") : veg.leafType.value;
  // Forma może mieć własny kształt, spód korony i kolor (trzcina, turzyce, krzewinki); drzewa biorą je z leaf_type.
  // W mieszance wymiary są wymiarami formy z profilu (obszar nie ma tagów wymiarów).
  const formName = formOf(veg, seed3), form = cfg.forms[formName], mixed = formName !== veg.form;
  const crown = form.crown ?? cfg.crowns[leaf] ?? "round", height = mixed ? form.heightMeters : veg.height.value, crownD = mixed ? form.crownDiameterMeters : veg.crown.value, crownR = crownD / 2;
  const crownBase = form.crownBaseFraction !== undefined ? height * form.crownBaseFraction : crown === "cone" ? height * cfg.coneBaseFraction : height - Math.min(crownD, height * cfg.roundMaxFraction);
  // Kolory projektu są w sRGB wprost (shadery nie przeliczają przestrzeni barw), jak w render/features.js.
  // Kwiaty: kolor z palety formy (hash miejsca), pozostałe formy: kolor formy albo liści.
  const hex = form.palette ? form.palette[Math.floor(seed2 * form.palette.length) % form.palette.length] : form.colour ?? cfg.colours[leaf] ?? cfg.colours[cfg.defaultLeafType];
  const colour = new THREE.Color().setStyle(hex, THREE.LinearSRGBColorSpace);
  colour.multiplyScalar(1 + (seed - 0.5) * 2 * cfg.colourVariation);
  const trunk = mixed ? form.trunkDiameterMeters : veg.trunk.value;
  return { crown, dims: [height, crownR, trunk / 2, crownBase], colour: [colour.r, colour.g, colour.b], yaw: seed2 * Math.PI * 2 };
}

/**
 * Instancje roślinności obiektu: [x, y, z, wysokość, promień korony, promień pnia, spód korony, obrót, r, g, b, kształt].
 * Wypełnienie obszarów pomija punkty bez terenu, w obszarach bez drzew i przy trasach (profile.vegetation.clearance).
 */
export function plantsOf(state, cfg, groundAt, clearance, clip = null) {
  const veg = state.interp.vegetation, f = state.feature, out = [];
  const put = (x, y, z, i, j) => {
    if (!Number.isFinite(z)) return;
    const p = plant(veg, cfg, hash(i, j, 1), hash(i, j, 2), hash(i, j, 5));
    out.push({ x, y, z, dims: p.dims, yaw: p.yaw, colour: p.colour, crown: p.crown });
  };
  if (veg.placement === "point") {
    const [x, y, z] = f.point;
    put(x, y, groundAt?.(x, y) ?? z, Math.round(x * 10), Math.round(y * 10));
  } else if (veg.placement === "row") {
    // Drzewa co `spacing` wzdłuż całej linii, od pierwszego pnia do ostatniego (Tag:natural=tree_row); ostatni pień
    // stoi na końcu linii, gdy od poprzedniego dzieli go co najmniej 40% odstępu.
    const p = f.points, at = (x, y, z) => put(x, y, groundAt?.(x, y) ?? z, Math.round(x * 10), Math.round(y * 10));
    let next = 0, walked = 0;
    for (let i = 3; i < p.length; i += 3) {
      const ax = p[i - 3], ay = p[i - 2], bx = p[i], by = p[i + 1], length = Math.hypot(bx - ax, by - ay);
      for (; next <= walked + length; next += veg.spacing) { const t = length ? (next - walked) / length : 0; at(ax + (bx - ax) * t, ay + (by - ay) * t, p[i - 1]); }
      walked += length;
    }
    if (p.length >= 6 && walked - (next - veg.spacing) >= veg.spacing * 0.4) at(p[p.length - 3], p[p.length - 2], p[p.length - 1]);
  } else if (state.interp.geometry === "area") {
    const step = veg.spacing, jitter = cfg.fillJitter * step, margin = Math.max(cfg.clearance.minMeters, veg.crown.value / 4);
    // Roślinność wodna (trzcina, turzyce) rośnie także w płytkiej wodzie: obszary wody jej nie blokują.
    const except = cfg.forms[veg.form].growsInWater ? "water" : null, ownSize = ringsArea(ringsOf(f));
    gridInside(ringsOf(f), step, (i, j) => {
      const x = i * step + (hash(i, j, 3) - 0.5) * 2 * jitter, y = j * step + (hash(i, j, 4) - 0.5) * 2 * jitter;
      if (clearance.blocked(x, y, margin, except, ownSize)) return;
      const z = groundAt?.(x, y);
      if (z === null || z === undefined) return;
      put(x, y, z, i, j);
    }, clip);
  }
  return out;
}

// Wzorce: pień (walec 6-boczny, z = 0…1) i korona: kula (dwudziestościan podzielony) albo stożek; dalekie są uproszczone.
function template(crown, near) {
  const pos = [], nor = [], part = [];
  const tri = (a, b, c, na, nb, nc, k) => { pos.push(...a, ...b, ...c); nor.push(...na, ...nb, ...nc); part.push(k, k, k); };
  if (near) {
    const sides = 6;
    for (let s = 0; s < sides; s += 1) {
      const a0 = (s / sides) * Math.PI * 2, a1 = ((s + 1) / sides) * Math.PI * 2;
      const p0 = [Math.cos(a0), Math.sin(a0)], p1 = [Math.cos(a1), Math.sin(a1)];
      const n0 = [...p0, 0], n1 = [...p1, 0];
      tri([...p0, 0], [...p1, 0], [...p1, 1], n0, n1, n1, 0);
      tri([...p0, 0], [...p1, 1], [...p0, 1], n0, n1, n0, 0);
    }
  }
  if (crown === "round") {
    const ball = new THREE.IcosahedronGeometry(1, near ? 1 : 0).getAttribute("position");
    for (let i = 0; i < ball.count; i += 3) {
      const v = [0, 1, 2].map((k) => [ball.getX(i + k), ball.getY(i + k), ball.getZ(i + k)]);
      tri(v[0], v[1], v[2], v[0], v[1], v[2], 1);
    }
  } else {
    const sides = near ? 9 : 4;
    for (let s = 0; s < sides; s += 1) {
      const a0 = (s / sides) * Math.PI * 2, a1 = ((s + 1) / sides) * Math.PI * 2, am = (a0 + a1) / 2;
      const p0 = [Math.cos(a0), Math.sin(a0), 0], p1 = [Math.cos(a1), Math.sin(a1), 0];
      tri(p0, p1, [0, 0, 1], [p0[0], p0[1], 1], [p1[0], p1[1], 1], [Math.cos(am), Math.sin(am), 1], 1);
      tri(p1, p0, [0, 0, 0], [0, 0, -1], [0, 0, -1], [0, 0, -1], 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(part, 1));
  return g;
}

export class VegetationLayer {
  constructor(shared, profile) {
    this.cfg = profile.vegetation;
    const { nearMeters, farMeters } = this.cfg.lod, trunk = this.cfg.colours.trunk;
    this.kinds = [];
    for (const crown of ["round", "cone"]) {
      for (const near of [true, false]) {
        this.kinds.push({ crown, near, reach: near ? nearMeters : farMeters, template: template(crown, near), material: vegetationMaterial(shared, { cone: crown === "cone", band: near ? [0, nearMeters] : [nearMeters, farMeters], trunkColour: trunk }) });
      }
    }
  }

  /** Siatki instancji dla roślin obiektów kawałka: osobno dla kształtu korony, szczegółowości i kwadratu 250 m. */
  meshes(entries, release) {
    const cells = new Map();
    for (const { plants, pick } of entries) {
      for (const p of plants) {
        const key = `${p.crown}|${Math.floor(p.x / CELL_METERS)}:${Math.floor(p.y / CELL_METERS)}`;
        if (!cells.has(key)) cells.set(key, { crown: p.crown, list: [] });
        cells.get(key).list.push(p, pick);
      }
    }
    const out = [];
    for (const { crown, list } of cells.values()) {
      const n = list.length / 2, base = new Float32Array(n * 3), dims = new Float32Array(n * 4), yaw = new Float32Array(n), colour = new Float32Array(n * 3), picks = new Float32Array(n * 3);
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, reach = 0;
      for (let k = 0; k < n; k += 1) {
        const p = list[k * 2], pick = list[k * 2 + 1];
        base.set([p.x, p.y, p.z], k * 3); dims.set(p.dims, k * 4); yaw[k] = p.yaw; colour.set(p.colour, k * 3); picks.set(pick, k * 3);
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z + p.dims[0]);
        reach = Math.max(reach, p.dims[1]);
      }
      const attributes = { aBase: [base, 3], aDims: [dims, 4], aYaw: [yaw, 1], aColor: [colour, 3], aPick: [picks, 3] };
      for (const kind of this.kinds.filter((k) => k.crown === crown)) {
        const geometry = new THREE.InstancedBufferGeometry();
        for (const name of ["position", "normal", "aPart"]) geometry.setAttribute(name, kind.template.getAttribute(name));
        for (const [name, [array, size]] of Object.entries(attributes)) geometry.setAttribute(name, new THREE.InstancedBufferAttribute(array, size).onUpload(release));
        geometry.instanceCount = n;
        const centre = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
        geometry.boundingSphere = new THREE.Sphere(centre, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + reach + 1);
        const mesh = new THREE.Mesh(geometry, kind.material);
        mesh.userData = { group: "landcover", reach: kind.reach, vegetation: true, plants: n };
        out.push(mesh);
      }
    }
    return out;
  }
}
