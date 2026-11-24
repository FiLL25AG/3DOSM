// Kafle danych: okno 3×3 kafli wokół kamery jest doczytywane z serwera (który buduje je w tle i trzyma w cache),
// odległe kafle są zwalniane z pamięci, a nowsza wersja kafla (po odświeżeniu źródeł) zastępuje poprzednią.
import * as THREE from "three";

const TICK_MS = 1500;
// Ponowne sprawdzenie, czy kamera już stoi, gdy czekają dane do przeliczenia (ms).
const CALM_RETRY_MS = 250;
// Zasięg kafla z serwera ma margines terenu 300 m (server/tiles.py: TERRAIN_MARGIN). Otoczenie zmienione przez kafel
// (węzły, pokrycie nawierzchni, budynki) sięga kilkudziesięciu metrów, więc obszar przebudowy to obrys kafla z zapasem 50 m.
const TERRAIN_MARGIN_METERS = 300, CHANGE_MARGIN_METERS = 50;
const changedArea = (e) => { const d = TERRAIN_MARGIN_METERS - CHANGE_MARGIN_METERS; return [e[0] + d, e[1] + d, e[2] - d, e[3] - d]; };

async function json(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

const keyOf = (tile) => `${tile.i}/${tile.j}`;

export class TileManager {
  constructor(app) {
    this.app = app;
    this.loaded = new Map();   // klucz kafla → { version, extent, features, relations, ids }
    this.owners = new Map();   // identyfikator obiektu → zbiór kluczy kafli, które go zawierają
    this.window = [];          // stan kafli w oknie 3×3 (z serwera)
    this.pending = new Map();  // kafel@wersja → pobierane dane (pobrane w tle, czekające na przeliczenie)
    this.busy = false;
  }

  start() {
    this.timer = setInterval(() => this.tick(), TICK_MS);
    return this.tick();
  }

  /** Jedno sprawdzenie okna: serwer kolejkuje brakujące kafle, gotowe nowe wersje są wczytywane, odległe zwalniane. */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const target = this.app.engine.rig.target;
      const { tiles } = await json(`/api/tiles/near?x=${target.x.toFixed(1)}&y=${target.y.toFixed(1)}`);
      this.window = tiles;
      const wanted = new Set(tiles.map(keyOf));
      const load = tiles.filter((tile) => tile.ready && this.loaded.get(keyOf(tile))?.version !== tile.version);
      const drop = [...this.loaded.keys()].filter((key) => !wanted.has(key));
      // Dane gotowych kafli są pobierane od razu, w tle; przeliczenie modelu i widoku czeka, aż kamera stanie,
      // bo trwa kilka sekund pracy (rozłożonej na klatki) i przycinałoby przelot.
      for (const tile of load) this._fetch(tile);
      const current = new Set(load.map((tile) => `${keyOf(tile)}@${tile.version}`));
      for (const id of [...this.pending.keys()]) if (!current.has(id)) this.pending.delete(id);
      if ((load.length || drop.length) && !this.app.engine.calm) { clearTimeout(this.retry); this.retry = setTimeout(() => this.tick(), CALM_RETRY_MS); }
      else if (load.length || drop.length) await this.apply(load, drop);
      this.app.onTiles?.(this.status());
    } catch (error) {
      this.app.onTiles?.({ error: error.message });
    } finally {
      this.busy = false;
    }
  }

  /** Dane kafla w danej wersji: jedno pobranie, wynik zapamiętany do chwili wczytania (albo zmiany wersji). */
  _fetch(tile) {
    const id = `${keyOf(tile)}@${tile.version}`;
    if (!this.pending.has(id)) {
      const request = json(`/api/tiles/${tile.i}/${tile.j}/features`);
      request.catch(() => this.pending.delete(id));
      this.pending.set(id, request);
    }
    return this.pending.get(id);
  }

  async apply(load, drop) {
    const bodies = await Promise.all(load.map((tile) => this._fetch(tile)));
    for (const tile of load) this.pending.delete(`${keyOf(tile)}@${tile.version}`);
    const remove = new Set(), regions = bodies.map((body) => changedArea(body.tile.extent));
    // Zwolnienie kafla (albo jego starszej wersji): obiekt znika, gdy żaden inny wczytany kafel go nie zawiera.
    for (const key of [...drop, ...load.map(keyOf).filter((key) => this.loaded.has(key))]) {
      regions.push(changedArea(this.loaded.get(key).extent));
      for (const id of this.loaded.get(key).ids) {
        const owners = this.owners.get(id);
        owners?.delete(key);
        if (!owners?.size) { this.owners.delete(id); remove.add(id); }
      }
      this.loaded.delete(key);
    }
    const add = [], relations = {};
    bodies.forEach((body, index) => {
      const key = keyOf(load[index]), ids = new Set();
      for (const feature of body.features) {
        ids.add(feature.id);
        if (!this.owners.has(feature.id)) this.owners.set(feature.id, new Set());
        this.owners.get(feature.id).add(key);
        add.push(feature);
      }
      Object.assign(relations, body.relations);
      this.loaded.set(key, { version: body.tile.version, extent: body.tile.extent, fetchedAt: body.tile.fetchedAt, ids });
    });
    // Obiekt, który zostaje w innym kafelku, nie jest usuwany; nowa wersja odświeżanego kafla zastępuje starą.
    const replaced = new Set(add.map((feature) => feature.id));
    const removeIds = [...remove].filter((id) => !this.owners.has(id) || replaced.has(id));
    await this.app.applyTiles(add, relations, removeIds, this.extent(), regions);
  }

  /** Zasięg wczytanych kafli (z marginesem terenu) w układzie lokalnym. */
  extent() {
    let extent = null;
    for (const { extent: e } of this.loaded.values()) {
      extent = extent ? [Math.min(extent[0], e[0]), Math.min(extent[1], e[1]), Math.max(extent[2], e[2]), Math.max(extent[3], e[3])] : [...e];
    }
    return extent;
  }

  status() {
    const counts = { ready: 0, building: 0, queued: 0, error: 0 };
    for (const tile of this.window) {
      if (this.loaded.has(keyOf(tile))) counts.ready += 1;
      else if (tile.state === "error") counts.error += 1;
      else if (tile.state === "building") counts.building += 1;
      else counts.queued += 1;
    }
    const building = this.window.find((tile) => tile.state === "building");
    return { ...counts, total: this.window.length, message: building ? `kafel ${building.i},${building.j}: ${building.message}` : "", errors: this.window.filter((t) => t.error).map((t) => `${t.i},${t.j}: ${t.error}`) };
  }

  /**
   * Kafle widoczne na ekranie: punkty siatki ekranu rzutowane na płaszczyznę terenu pod celem kamery
   * (w granicach okna 3×3, bo tylko te kafle są wczytane).
   */
  visibleTiles() {
    const { camera, rig } = this.app.engine, plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -rig.target.z), ray = new THREE.Raycaster(), hit = new THREE.Vector3(), seen = new Set();
    for (let sx = -1; sx <= 1.001; sx += 0.25) {
      for (let sy = -1; sy <= 1.001; sy += 0.25) {
        ray.setFromCamera(new THREE.Vector2(sx, sy), camera);
        if (!ray.ray.intersectPlane(plane, hit)) continue;
        for (const tile of this.window) {
          const e = this.loaded.get(keyOf(tile))?.extent;
          // Zasięg kafla zawiera margines terenu, więc punkt przy granicy może wskazać także sąsiedni kafel (odświeżony nadmiarowo).
          if (e && hit.x >= e[0] && hit.x <= e[2] && hit.y >= e[1] && hit.y <= e[3]) seen.add(keyOf(tile));
        }
      }
    }
    return this.window.filter((tile) => seen.has(keyOf(tile))).map((tile) => [tile.i, tile.j]);
  }
}
