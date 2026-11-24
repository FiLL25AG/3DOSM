// Dopasowanie rysowanego terenu do tras: jak w terenie, to grunt jest wyprofilowany pod drogę, a nie droga pod każdą nierówność NMT.
// Dotyczy wyłącznie obrazu. Dane NMT, wysokości tras, poziomy i kolizje pozostają bez zmian.
import * as THREE from "three";

// Bok teksela dopasowania (m); siatka ma do MAX_TEXELS tekseli w każdym kierunku.
const TEXEL_METERS = 3, MAX_TEXELS = 4096, BLOCK = 32;
// Pas terenu przy ścianie oporowej po jej niższej stronie: pełne obniżenie do dołu ściany i powrót do NMT (m).
// W tym samym pasie shader odrzuca teren, a ściana ma posadzkę na poziomie swojego dołu (ostry uskok przy licu).
export const WALL_BAND_METERS = 4;
const WALL_FEATHER_METERS = 3;
// Liczba obiektów sprawdzanych w jednym etapie dopasowania przy doczytywaniu kafli.
const CONFORM_BATCH = 20000;
export const CORE_METERS = 1, FEATHER_METERS = 7, CONFORM_REFERENCE_Z = 85;
// Maska tuneli: nad tubą teren zasłania dokładniej, aby jej wnętrze nie prześwitywało przez zapas głębi terenu.
const TUNNEL_MASK_MARGIN_METERS = 1.5, TUNNEL_MASK_FEATHER_METERS = 3;
const CONFORM_GROUPS = new Set(["rail", "water"]);

const smooth = (t) => t * t * (3 - 2 * t);

export function conformsTerrain(state) {
  const { feature, interp, level } = state, def = interp.classDef;
  if (feature.geometry !== "way" || interp.geometry !== "line" || !level?.z || level.lifted || ["culvert", "tunnel"].includes(interp.attributes.structure)) return false;
  return Boolean(def.surfaced) || CONFORM_GROUPS.has(def.group);
}

export class GroundConform {
  /**
   * Siatka tekseli o stałym boku TEXEL_METERS zakotwiczona w układzie lokalnym (wielokrotności boku), więc przy zmianie
   * zasięgu (doczytane kafle danych) teksele w części wspólnej leżą w tych samych miejscach: są kopiowane z poprzedniej
   * siatki, a stemplowane od nowa są tylko zmienione obszary. Teksel (i, j) ma środek w west + (i + 0,5) * bok.
   */
  constructor(extent, previous = null) {
    const [west, south, east, north] = extent, T = TEXEL_METERS;
    const i0 = Math.floor(west / T), j0 = Math.floor(south / T);
    const width = Math.min(MAX_TEXELS, Math.ceil(east / T) - i0), height = Math.min(MAX_TEXELS, Math.ceil(north / T) - j0);
    Object.assign(this, { i0, j0, width, height, west: i0 * T, south: j0 * T, scaleX: 1 / T, scaleY: 1 / T });
    this.extent = [this.west, this.south, this.west + width * T, this.south + height * T];
    this.data = new Float32Array(width * height * 2);
    this.texture = new THREE.DataTexture(this.data, width, height, THREE.RGFormat, THREE.FloatType);
    this.texture.internalFormat = "RG32F";
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
    this.mask = new Uint8Array(width * height);
    this.maskTexture = new THREE.DataTexture(this.mask, width, height, THREE.RedFormat, THREE.UnsignedByteType);
    this.maskTexture.minFilter = this.maskTexture.magFilter = THREE.LinearFilter;
    this.maskTexture.wrapS = this.maskTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.maskTexture.needsUpdate = true;
    this.wallIndex = new Float32Array(width * height);
    this.wallIndexTexture = new THREE.DataTexture(this.wallIndex, width, height, THREE.RedFormat, THREE.FloatType);
    this.wallIndexTexture.minFilter = this.wallIndexTexture.magFilter = THREE.NearestFilter;
    this.wallIndexTexture.needsUpdate = true;
    this.wallDataTexture = null;
    this.wallCount = 0;
    if (previous) this._copy(previous);
  }

  /**
   * Cięcie terenu przy ścianach oporowych: w każdym tekselu numer (od 1) najbliższego odcinka ściany, którego pas po niższej
   * stronie może obejmować piksele teksela, oraz tekstura odcinków (wiersz 0: ax, ay, bx, by; wiersz 1: ściana, strona
   * niższa ±1, szerokość pasa). Shader liczy dokładną odległość i stronę piksela, także dla sąsiednich odcinków tej samej ściany.
   */
  stampWallCut(segments) {
    this.wallIndex.fill(0);
    const best = new Float32Array(this.wallIndex.length).fill(Infinity), margin = 0.75 / this.scaleX * 2;
    segments.forEach((s, n) => {
      const reach = s.band + margin, dx = s.bx - s.ax, dy = s.by - s.ay, l2 = dx * dx + dy * dy || 1e-4, l = Math.sqrt(l2);
      const r = this._rect([Math.min(s.ax, s.bx) - reach, Math.min(s.ay, s.by) - reach, Math.max(s.ax, s.bx) + reach, Math.max(s.ay, s.by) + reach]);
      if (!r) return;
      for (let j = r[1]; j <= r[3]; j += 1) {
        const y = this.south + (j + 0.5) / this.scaleY;
        for (let i = r[0]; i <= r[2]; i += 1) {
          const x = this.west + (i + 0.5) / this.scaleX, t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / l2));
          const d = Math.hypot(x - s.ax - dx * t, y - s.ay - dy * t), side = ((dx * (y - s.ay) - dy * (x - s.ax)) / l) * s.lower;
          if (d > reach || side < -margin) continue;
          const k = j * this.width + i;
          if (d < best[k]) { best[k] = d; this.wallIndex[k] = n + 1; }
        }
      }
    });
    this.wallIndexTexture.needsUpdate = true;
    const count = Math.max(1, segments.length), data = new Float32Array(count * 2 * 4);
    segments.forEach((s, n) => {
      data.set([s.ax, s.ay, s.bx, s.by], n * 4);
      data.set([s.wall, s.lower, s.band, 0], (count + n) * 4);
    });
    this.wallDataTexture?.dispose();
    this.wallDataTexture = new THREE.DataTexture(data, count, 2, THREE.RGBAFormat, THREE.FloatType);
    this.wallDataTexture.minFilter = this.wallDataTexture.magFilter = THREE.NearestFilter;
    this.wallDataTexture.needsUpdate = true;
    this.wallCount = segments.length;
  }

  /** Prostokąty (m) tej siatki leżące poza poprzednią: nie mają skopiowanych danych i wymagają stemplowania. */
  uncovered(previous) {
    if (!previous) return [this.extent];
    const [w, s, e, n] = this.extent, [pw, ps, pe, pn] = previous.extent, out = [];
    if (pe <= w || pw >= e || pn <= s || ps >= n) return [this.extent];
    if (s < ps) out.push([w, s, e, ps]);
    if (n > pn) out.push([w, pn, e, n]);
    const y0 = Math.max(s, ps), y1 = Math.min(n, pn);
    if (w < pw) out.push([w, y0, pw, y1]);
    if (e > pe) out.push([pe, y0, e, y1]);
    return out;
  }

  /** Część wspólna z poprzednią siatką (ten sam bok tekseli, przesunięcie o całkowitą liczbę tekseli). */
  _copy(previous) {
    const di = this.i0 - previous.i0, dj = this.j0 - previous.j0;
    const x0 = Math.max(0, -di), x1 = Math.min(this.width, previous.width - di);
    if (x1 <= x0) return;
    for (let j = Math.max(0, -dj); j < Math.min(this.height, previous.height - dj); j += 1) {
      const from = ((j + dj) * previous.width + x0 + di) * 2, to = (j * this.width + x0) * 2;
      this.data.set(previous.data.subarray(from, from + (x1 - x0) * 2), to);
    }
  }

  /** Prostokąt tekseli [x0, y0, x1, y1] (włącznie) dla prostokąta w metrach, przycięty do siatki; null poza siatką. */
  _rect([west, south, east, north]) {
    const x0 = Math.max(0, Math.floor((west - this.west) * this.scaleX)), x1 = Math.min(this.width - 1, Math.floor((east - this.west) * this.scaleX));
    const y0 = Math.max(0, Math.floor((south - this.south) * this.scaleY)), y1 = Math.min(this.height - 1, Math.floor((north - this.south) * this.scaleY));
    return x1 < x0 || y1 < y0 ? null : [x0, y0, x1, y1];
  }

  /** Obrysy tub tuneli w masce: 1 nad tubą i w pasie zapasu, potem łagodnie do zera. */
  stampTunnels(cuts) {
    this.mask.fill(0);
    for (const c of cuts) {
      const reach = c.half + TUNNEL_MASK_MARGIN_METERS + TUNNEL_MASK_FEATHER_METERS;
      const r = this._rect([Math.min(c.ax, c.bx) - reach, Math.min(c.ay, c.by) - reach, Math.max(c.ax, c.bx) + reach, Math.max(c.ay, c.by) + reach]);
      if (!r) continue;
      const dx = c.bx - c.ax, dy = c.by - c.ay, l2 = dx * dx + dy * dy || 1;
      for (let j = r[1]; j <= r[3]; j += 1) {
        for (let i = r[0]; i <= r[2]; i += 1) {
          const x = this.west + (i + 0.5) / this.scaleX, y = this.south + (j + 0.5) / this.scaleY, t = Math.max(0, Math.min(1, ((x - c.ax) * dx + (y - c.ay) * dy) / l2));
          const d = Math.hypot(x - c.ax - dx * t, y - c.ay - dy * t) - c.half - TUNNEL_MASK_MARGIN_METERS;
          const w = d <= 0 ? 255 : d >= TUNNEL_MASK_FEATHER_METERS ? 0 : Math.round(255 * (1 - smooth(d / TUNNEL_MASK_FEATHER_METERS))), k = j * this.width + i;
          if (w > this.mask[k]) this.mask[k] = w;
        }
      }
    }
    this.maskTexture.needsUpdate = true;
  }

  /** Całe dopasowanie od nowa. */
  rebuild(model, axisOf = (state) => state.feature.points, walls = []) { this.update(model, axisOf, [this.extent], walls); }

  /**
   * Dopasowanie w podanych prostokątach (m): teksele w nich są czyszczone i stemplowane od nowa przez wszystkie trasy,
   * których pas wpływu je obejmuje; teksele poza prostokątami pozostają bez zmian. Trasa jest stemplowana odcinkami:
   * waga zależy od odległości od odcinka, a wysokość jest wysokością trasy w rzucie punktu na odcinek.
   */
  update(model, axisOf = (state) => state.feature.points, regions = [this.extent], walls = []) {
    const steps = this.updateSteps(model, axisOf, regions, walls);
    while (!steps.next().done);
  }

  /** To samo co update, etapami (yield co CONFORM_BATCH obiektów i przed ścianami) przy doczytywaniu kafli. */
  *updateSteps(model, axisOf = (state) => state.feature.points, regions = [this.extent], walls = []) {
    // Obszary są sumowane w masce bloków BLOCK × BLOCK tekseli: każdy teksel jest czyszczony i stemplowany raz,
    // niezależnie od tego, ile prostokątów go obejmuje.
    const bw = Math.ceil(this.width / BLOCK), bh = Math.ceil(this.height / BLOCK), dirty = new Uint8Array(bw * bh);
    let any = false;
    for (const region of regions) {
      const r = this._rect(region);
      if (!r) continue;
      any = true;
      for (let by = Math.floor(r[1] / BLOCK); by <= Math.floor(r[3] / BLOCK); by += 1) dirty.fill(1, by * bw + Math.floor(r[0] / BLOCK), by * bw + Math.floor(r[2] / BLOCK) + 1);
    }
    if (!any) return;
    const { data, width, height } = this;
    for (let by = 0; by < bh; by += 1) {
      for (let bx = 0; bx < bw; bx += 1) {
        if (!dirty[by * bw + bx]) continue;
        const x0 = bx * BLOCK, x1 = Math.min(width, x0 + BLOCK);
        for (let j = by * BLOCK; j < Math.min(height, (by + 1) * BLOCK); j += 1) data.fill(0, (j * width + x0) * 2, (j * width + x1) * 2);
      }
    }
    // Blok punktu; punkt poza siatką trafia do bloku brzegowego, bo tam leży przycięta część pasa wpływu.
    const blockDirty = (x, y) => {
      const bx = Math.max(0, Math.min(bw - 1, Math.floor(((x - this.west) * this.scaleX) / BLOCK))), by = Math.max(0, Math.min(bh - 1, Math.floor(((y - this.south) * this.scaleY) / BLOCK)));
      return dirty[by * bw + bx] === 1;
    };
    // Wysokość jest zapisana pomnożona przez wagę, aby filtrowanie tekstury nie ciągnęło terenu ku zeru na brzegu pasa.
    const stamp = (ax, ay, bx, by, za, zb, half) => {
      const reach = half + CORE_METERS + FEATHER_METERS;
      const r = this._rect([Math.min(ax, bx) - reach, Math.min(ay, by) - reach, Math.max(ax, bx) + reach, Math.max(ay, by) + reach]);
      if (!r) return;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      for (let cy = Math.floor(r[1] / BLOCK); cy <= Math.floor(r[3] / BLOCK); cy += 1) {
        for (let cx = Math.floor(r[0] / BLOCK); cx <= Math.floor(r[2] / BLOCK); cx += 1) {
          if (!dirty[cy * bw + cx]) continue;
          const x0 = Math.max(r[0], cx * BLOCK), x1 = Math.min(r[2], cx * BLOCK + BLOCK - 1), y0 = Math.max(r[1], cy * BLOCK), y1 = Math.min(r[3], cy * BLOCK + BLOCK - 1);
          for (let j = y0; j <= y1; j += 1) {
            const y = this.south + (j + 0.5) / this.scaleY;
            for (let i = x0; i <= x1; i += 1) {
              const x = this.west + (i + 0.5) / this.scaleX, t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
              const d = Math.hypot(x - ax - dx * t, y - ay - dy * t) - half - CORE_METERS;
              if (d >= FEATHER_METERS) continue;
              const w = d <= 0 ? 1 : 1 - smooth(d / FEATHER_METERS), z = za + (zb - za) * t, k = (j * width + i) * 2;
              // Gdzie spotyka się kilka tras, teren trzyma się najniższej, aby żadnej nie przykryć (przy wadze 1 zapis to wprost wysokość).
              if (w > data[k + 1]) { data[k] = (z - CONFORM_REFERENCE_Z) * w; data[k + 1] = w; } else if (w === 1 && z - CONFORM_REFERENCE_Z < data[k]) data[k] = z - CONFORM_REFERENCE_Z;
            }
          }
        }
      }
    };
    const blockMeters = BLOCK / this.scaleX;
    let count = 0;
    for (const state of model.states.values()) {
      if ((count += 1) % CONFORM_BATCH === 0) yield "dopasowanie";
      if (!conformsTerrain(state)) continue;
      const points = axisOf(state), { z } = state.level, half = (state.interp.dimensions.width?.value ?? state.interp.classDef.widthMeters ?? 2) / 2, reach = half + CORE_METERS + FEATHER_METERS;
      for (let i = 3; i < points.length; i += 3) {
        const ax = points[i - 3], ay = points[i - 2], bx = points[i], by = points[i + 1];
        // Szybkie pominięcie: pas wpływu krótszy niż blok leży w co najwyżej 2 × 2 blokach, czyli w blokach swoich narożników.
        const x0 = Math.min(ax, bx) - reach, x1 = Math.max(ax, bx) + reach, y0 = Math.min(ay, by) - reach, y1 = Math.max(ay, by) + reach;
        if (x1 - x0 < blockMeters && y1 - y0 < blockMeters && !blockDirty(x0, y0) && !blockDirty(x1, y0) && !blockDirty(x0, y1) && !blockDirty(x1, y1)) continue;
        stamp(ax, ay, bx, by, z[i / 3 - 1], z[i / 3], half);
      }
    }
    // Ściana oporowa trzyma skarpę: po niższej stronie (wall.lower: −1 prawa, +1 lewa względem kierunku ściany) teren w pasie WALL_BAND_METERS
    // leży na poziomie dołu ściany, dalej łagodnie wraca do NMT. Wyższa strona zostaje bez zmian. Reguła jak dla tras:
    // większa waga wygrywa, a przy pełnej wadze niższa wysokość, więc pas nie przykrywa tras.
    yield "dopasowanie";
    for (const wall of walls) {
      const { xs, ys, lows, lower = -1 } = wall, reach = WALL_BAND_METERS + WALL_FEATHER_METERS;
      for (let n = 1; n < xs.length; n += 1) {
        const ax = xs[n - 1], ay = ys[n - 1], bx = xs[n], by = ys[n], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        if (l2 < 1e-4) continue;
        const r = this._rect([Math.min(ax, bx) - reach, Math.min(ay, by) - reach, Math.max(ax, bx) + reach, Math.max(ay, by) + reach]);
        if (!r) continue;
        for (let j = r[1]; j <= r[3]; j += 1) {
          const y = this.south + (j + 0.5) / this.scaleY;
          for (let i = r[0]; i <= r[2]; i += 1) {
            if (!dirty[Math.floor(j / BLOCK) * bw + Math.floor(i / BLOCK)]) continue;
            const x = this.west + (i + 0.5) / this.scaleX;
            // Tylko strona niższa: lower −1 to prawa (iloczyn wektorowy ujemny), +1 lewa.
            if ((dx * (y - ay) - dy * (x - ax)) * lower < 0) continue;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)), d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
            if (d >= reach) continue;
            const w = d <= WALL_BAND_METERS ? 1 : 1 - smooth((d - WALL_BAND_METERS) / WALL_FEATHER_METERS), zz = lows[n - 1] + (lows[n] - lows[n - 1]) * t, k = (j * width + i) * 2;
            if (w > data[k + 1]) { data[k] = (zz - CONFORM_REFERENCE_Z) * w; data[k + 1] = w; } else if (w === 1 && zz - CONFORM_REFERENCE_Z < data[k]) data[k] = zz - CONFORM_REFERENCE_Z;
          }
        }
      }
    }
    this.texture.needsUpdate = true;
  }

  /** Wysokość rysowanego terenu: NMT wraz z dopasowaniem do tras, filtrowana jak w shaderze. */
  ground(x, y, base) {
    const u = Math.max(0, Math.min(this.width - 1.001, (x - this.west) * this.scaleX - 0.5)), v = Math.max(0, Math.min(this.height - 1.001, (y - this.south) * this.scaleY - 0.5)), i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    const at = (a, b, c) => this.data[((j + b) * this.width + i + a) * 2 + c], mix = (c) => (at(0, 0, c) * (1 - fu) + at(1, 0, c) * fu) * (1 - fv) + (at(0, 1, c) * (1 - fu) + at(1, 1, c) * fu) * fv;
    const weight = Math.min(1, mix(1));
    return weight > 0.001 ? base + (CONFORM_REFERENCE_Z + mix(0) / mix(1) - base) * weight : base;
  }

  /** Waga i wysokość dopasowania w punkcie; używane w testach i kontroli. */
  sample(x, y) {
    const i = Math.max(0, Math.min(this.width - 1, Math.floor((x - this.west) * this.scaleX))), j = Math.max(0, Math.min(this.height - 1, Math.floor((y - this.south) * this.scaleY))), k = (j * this.width + i) * 2, weight = this.data[k + 1];
    return { weight, height: weight > 0 ? CONFORM_REFERENCE_Z + this.data[k] / weight : null };
  }
}
