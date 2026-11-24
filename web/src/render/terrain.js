// Kafle terenu: rodzic pozostaje widoczny, dopóki wszystkie dzieci nie są gotowe (bez pustych luk).
import * as THREE from "three";

function releaseArray() { this.array = null; }

const MAX_CONCURRENT = 6;
const TILE_BUDGET = 420;
const SKIRT = 25;

/** Wysokości NMT z jednego poziomu kafli, niezależne od tego, co akurat widać na ekranie. */
export async function loadGroundSampler(tiles, positions, level = 5, cache = null) {
  // cache: wspólna mapa pobranych kafli (klucz → siatka albo null dla pustego), aby kolejne wywołania pobierały tylko brakujące.
  const z = Math.min(level, tiles.maxLevel), size = tiles.rootSize / 2 ** z, step = size / tiles.cells, n = tiles.cells + 1, grids = cache ?? new Map();
  // Róg korzenia piramidy w układzie lokalnym (stała siatka PL-1992); starszy manifest bez rogu: korzeń wokół początku.
  const rootWest = tiles.rootWest ?? -tiles.rootSize / 2, rootSouth = tiles.rootSouth ?? -tiles.rootSize / 2;
  const indexOf = (value, root) => Math.floor((value - root) / size), wanted = new Set();
  for (let i = 0; i < positions.length; i += 2) for (const dx of [-8, 8]) for (const dy of [-8, 8]) wanted.add(`${indexOf(positions[i] + dx, rootWest)}/${indexOf(positions[i + 1] + dy, rootSouth)}`);
  const queue = [...wanted].filter((key) => !grids.has(key));
  const worker = async () => {
    while (queue.length) {
      const key = queue.pop(), response = await fetch(`/api/terrain/${z}/${key}`);
      if (response.status === 200) grids.set(key, new Float32Array(await response.arrayBuffer(), 0, n * n));
      else if (response.status === 204) grids.set(key, null);
    }
  };
  await Promise.all(Array.from({ length: MAX_CONCURRENT }, worker));
  return (x, y) => {
    const tx = indexOf(x, rootWest), ty = indexOf(y, rootSouth), grid = grids.get(`${tx}/${ty}`);
    if (!grid) return null;
    const west = rootWest + tx * size, south = rootSouth + ty * size, ix = Math.min(tiles.cells - 1, Math.floor((x - west) / step)), iy = Math.min(tiles.cells - 1, Math.floor((y - south) / step)), u = (x - west) / step - ix, v = (y - south) / step - iy;
    const value = grid[iy * n + ix] * (1 - u) * (1 - v) + grid[iy * n + ix + 1] * u * (1 - v) + grid[(iy + 1) * n + ix] * (1 - u) * v + grid[(iy + 1) * n + ix + 1] * u * v;
    return Number.isFinite(value) ? value : null;
  };
}

export class TerrainSystem {
  constructor(tiles, material, onChange) {
    Object.assign(this, { material, onChange });
    this.rootSize = tiles.rootSize; this.cells = tiles.cells; this.maxLevel = tiles.maxLevel;
    this.rootWest = tiles.rootWest ?? -tiles.rootSize / 2; this.rootSouth = tiles.rootSouth ?? -tiles.rootSize / 2;
    this.size = this.cells + 1;
    this.group = new THREE.Group();
    this.tiles = new Map();
    // Siatki kafli jeszcze niewysłane na GPU (silnik wysyła je w tle, potem zwalnia kopie w pamięci JS).
    this.unuploaded = [];
    this.queue = [];
    this.active = 0;
    this.detail = 1;
    this.stats = { requested: 0, loaded: 0, empty: 0, firstCoverMs: null, idleMs: null, drawn: 0 };
    this.started = performance.now();
    this.fullIndex = this._index(null);
    // Zasięg wczytanych danych [w, s, e, n] w układzie lokalnym (Engine.setExtent); null: bez ograniczenia.
    this.dataExtent = null;
  }

  key(z, x, y) { return `${z}/${x}/${y}`; }

  /** Nowe dane wysokości po stronie serwera (wczytany kafel danych): kafle terenu są pobierane od nowa. */
  reset() {
    this.generation = (this.generation ?? 0) + 1;
    for (const tile of this.tiles.values()) if (tile.mesh) { this.group.remove(tile.mesh); tile.mesh.geometry.dispose(); }
    this.tiles.clear();
    this.queue = [];
    this.onChange();
  }

  _index(valid) {
    const n = this.size, out = [];
    const ok = (i) => !valid || valid[i];
    for (let y = 0; y < this.cells; y += 1) {
      for (let x = 0; x < this.cells; x += 1) {
        const a = y * n + x, b = a + 1, c = a + n, d = c + 1;
        if (ok(a) && ok(b) && ok(c) && ok(d)) out.push(a, b, d, a, d, c);
      }
    }
    const base = n * n;
    const edge = (index, position, flip) => {
      const skirt = base + position;
      return { index, skirt, flip };
    };
    const rim = [];
    for (let i = 0; i < n; i += 1) rim.push(edge(i, i), edge((n - 1) * n + i, n + i));
    for (let i = 0; i < n; i += 1) rim.push(edge(i * n, 2 * n + i), edge(i * n + n - 1, 3 * n + i));
    for (let side = 0; side < 4; side += 1) {
      for (let i = 0; i < n - 1; i += 1) {
        const a = rim[side < 2 ? i * 2 + side : 2 * n + i * 2 + side - 2], b = rim[side < 2 ? (i + 1) * 2 + side : 2 * n + (i + 1) * 2 + side - 2];
        if (ok(a.index) && ok(b.index)) out.push(a.index, b.index, b.skirt, a.index, b.skirt, a.skirt);
      }
    }
    return new THREE.BufferAttribute(new Uint16Array(out), 1);
  }

  bounds(z, x, y) {
    const size = this.rootSize / 2 ** z;
    return { west: this.rootWest + x * size, south: this.rootSouth + y * size, size };
  }

  _request(z, x, y) {
    const key = this.key(z, x, y);
    let tile = this.tiles.get(key);
    if (!tile) {
      tile = { key, z, x, y, state: "queued", mesh: null, heights: null, used: 0, generation: this.generation ?? 0 };
      this.tiles.set(key, tile);
      this.queue.push(tile);
      this.stats.requested += 1;
    }
    return tile;
  }

  _pump(camera) {
    if (this.active >= MAX_CONCURRENT || !this.queue.length) return;
    const score = (tile) => {
      const b = this.bounds(tile.z, tile.x, tile.y);
      return tile.z * 1e5 + Math.hypot(b.west + b.size / 2 - camera.x, b.south + b.size / 2 - camera.y);
    };
    this.queue.sort((a, b) => score(a) - score(b));
    while (this.active < MAX_CONCURRENT && this.queue.length) this._load(this.queue.shift());
  }

  async _load(tile) {
    this.active += 1;
    tile.state = "loading";
    try {
      const response = await fetch(`/api/terrain/${tile.z}/${tile.x}/${tile.y}`);
      if (response.status === 204) tile.state = "empty";
      else if (!response.ok) throw new Error(String(response.status));
      else { const buffer = await response.arrayBuffer(); if (tile.generation === (this.generation ?? 0)) this._build(tile, buffer); }
      this.stats[tile.state === "empty" ? "empty" : "loaded"] += 1;
    } catch {
      tile.state = "failed";
    }
    this.active -= 1;
    if (tile.z === 0 && this.stats.firstCoverMs === null) this.stats.firstCoverMs = Math.round(performance.now() - this.started);
    if (!this.active && !this.queue.length) this.stats.idleMs = Math.round(performance.now() - this.started);
    this.onChange();
  }

  _build(tile, buffer) {
    const n = this.size, count = n * n;
    const heights = new Float32Array(buffer, 0, count);
    const flags = new Uint8Array(buffer, count * 4, count);
    const { west, south, size } = this.bounds(tile.z, tile.x, tile.y);
    const step = size / this.cells;
    const total = count + 4 * n;
    const position = new Float32Array(total * 3), normal = new Float32Array(total * 3), flag = new Float32Array(total);
    const valid = new Uint8Array(count);
    let complete = true;
    for (let i = 0; i < count; i += 1) { valid[i] = Number.isFinite(heights[i]) ? 1 : 0; if (!valid[i]) complete = false; }
    const at = (x, y, fallback) => { const v = heights[y * n + x]; return Number.isFinite(v) ? v : fallback; };
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const i = y * n + x, h = valid[i] ? heights[i] : 0;
        position.set([west + x * step, south + y * step, h], i * 3);
        const dx = at(Math.min(x + 1, n - 1), y, h) - at(Math.max(x - 1, 0), y, h);
        const dy = at(x, Math.min(y + 1, n - 1), h) - at(x, Math.max(y - 1, 0), h);
        const length = Math.hypot(dx, dy, 2 * step);
        normal.set([-dx / length, -dy / length, (2 * step) / length], i * 3);
        flag[i] = flags[i] === 1 ? 1 : 0;
      }
    }
    const copy = (target, source) => {
      position.set([position[source * 3], position[source * 3 + 1], position[source * 3 + 2] - SKIRT], target * 3);
      normal.set([normal[source * 3], normal[source * 3 + 1], normal[source * 3 + 2]], target * 3);
    };
    for (let i = 0; i < n; i += 1) {
      copy(count + i, i); copy(count + n + i, (n - 1) * n + i);
      copy(count + 2 * n + i, i * n); copy(count + 3 * n + i, i * n + n - 1);
    }
    const geometry = new THREE.BufferGeometry();
    // Kopie danych w pamięci JS są zwalniane po wysłaniu na GPU; wysokości kafla zostają w tile.heights (wysokość pod kamerą).
    geometry.setAttribute("position", new THREE.BufferAttribute(position, 3).onUpload(releaseArray));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3).onUpload(releaseArray));
    geometry.setAttribute("aFlag", new THREE.BufferAttribute(flag, 1).onUpload(releaseArray));
    // Rozmiar oczka: zgrubny kafel nie może zasłaniać tras, których przebiegu jeszcze nie odwzorowuje.
    geometry.setAttribute("aCell", new THREE.BufferAttribute(new Float32Array(total).fill(step), 1).onUpload(releaseArray));
    geometry.setIndex(complete ? this.fullIndex : this._index(valid));
    geometry.computeBoundingSphere();
    tile.mesh = new THREE.Mesh(geometry, this.material);
    tile.mesh.visible = false;
    tile.mesh.renderOrder = 0;
    tile.heights = heights;
    tile.state = "ready";
    this.group.add(tile.mesh);
    this.unuploaded.push(tile.mesh);
  }

  update(cameraPosition, frustum) {
    for (const tile of this.tiles.values()) if (tile.mesh) tile.mesh.visible = false;
    let drawn = 0;
    const stamp = performance.now();
    const settled = (tile) => tile.state === "ready" || tile.state === "empty" || tile.state === "failed";
    // Pusty kafel (brak danych w jego próbkach, np. gruby poziom złożony z małych mozaik) nie jest rysowany, ale nie
    // zatrzymuje schodzenia: dane mogą być na dokładniejszych poziomach. Wcześniej pusty korzeń wyłączał cały teren.
    // Poza zasięgiem wczytanych danych (dataExtent) serwer nie ma wysokości: takie kafle nie są pobierane.
    const inData = (z, x, y) => {
      const e = this.dataExtent, b = this.bounds(z, x, y);
      return !e || !(b.west > e[2] || b.west + b.size < e[0] || b.south > e[3] || b.south + b.size < e[1]);
    };
    const visit = (z, x, y) => {
      if (!inData(z, x, y)) return false;
      const tile = this._request(z, x, y);
      tile.used = stamp;
      if (!settled(tile) || tile.state === "failed") return false;
      const { west, south, size } = this.bounds(z, x, y);
      const cx = Math.max(west, Math.min(cameraPosition.x, west + size));
      const cy = Math.max(south, Math.min(cameraPosition.y, south + size));
      const distance = Math.hypot(cx - cameraPosition.x, cy - cameraPosition.y, cameraPosition.z - 90);
      let refined = false;
      if (z < this.maxLevel && distance < size * 1.6 * this.detail) {
        const children = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j]) => [z + 1, x * 2 + i, y * 2 + j]).filter((c) => inData(...c)).map((c) => this._request(...c));
        children.forEach((child) => { child.used = stamp; });
        if (children.every(settled)) {
          refined = true;
          for (const child of children) if (child.state !== "failed") visit(child.z, child.x, child.y);
        }
      }
      if (!refined && tile.mesh) {
        tile.mesh.visible = true;
        if (frustum.intersectsObject(tile.mesh)) drawn += 1;
      }
      return true;
    };
    visit(0, 0, 0);
    this.stats.drawn = drawn;
    this._pump(cameraPosition);
    this._evict(stamp);
  }

  _evict(stamp) {
    if (this.tiles.size <= TILE_BUDGET) return;
    const stale = [...this.tiles.values()].filter((t) => t.used !== stamp && t.z > 1 && t.state !== "loading" && t.state !== "queued").sort((a, b) => a.used - b.used);
    for (const tile of stale.slice(0, this.tiles.size - TILE_BUDGET)) {
      if (tile.mesh) {
        this.group.remove(tile.mesh);
        if (tile.mesh.geometry.index !== this.fullIndex) tile.mesh.geometry.index = null;
        tile.mesh.geometry.dispose();
      }
      this.tiles.delete(tile.key);
    }
  }

  /** Czy żaden kafel nie czeka już na pobranie. */
  get settled() { return !this.active && !this.queue.length; }

  heightAt(x, y) {
    let best = null;
    for (let z = 0; z <= this.maxLevel; z += 1) {
      const size = this.rootSize / 2 ** z;
      const tx = Math.floor((x - this.rootWest) / size), ty = Math.floor((y - this.rootSouth) / size);
      // Puste i brakujące poziomy są pomijane (nie przerywają szukania): dokładniejszy poziom może mieć dane.
      const tile = this.tiles.get(this.key(z, tx, ty));
      if (!tile || tile.state !== "ready") continue;
      const { west, south } = this.bounds(z, tx, ty);
      const step = size / this.cells;
      const ix = Math.min(this.cells - 1, Math.floor((x - west) / step)), iy = Math.min(this.cells - 1, Math.floor((y - south) / step));
      const u = (x - west) / step - ix, v = (y - south) / step - iy, n = this.size, h = tile.heights;
      const value = h[iy * n + ix] * (1 - u) * (1 - v) + h[iy * n + ix + 1] * u * (1 - v) + h[(iy + 1) * n + ix] * (1 - u) * v + h[(iy + 1) * n + ix + 1] * u * v;
      if (Number.isFinite(value)) best = value;
    }
    return best;
  }
}
