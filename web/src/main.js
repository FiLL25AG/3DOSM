// Start aplikacji i przepływ użytkownika: dane → model → scena → panele.
import { wgs84ToPl1992 } from "./core/crs.js";
import { boundsOf, SceneModel } from "./core/model.js";
import { t } from "./i18n.js";
import { Engine } from "./render/engine.js";
import { TileManager } from "./tiles.js";
import { BottomPanel } from "./ui/bottomPanel.js";
import { h, link } from "./ui/dom.js";
import { TopPanel } from "./ui/topPanel.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

class App {
  constructor() { this.selected = null; this.detail = 1; this.exaggeration = 1; this.relief = true; this.cache = null; }

  async start() {
    let status = await json("/api/status");
    while (status.state === "building" || status.state === "idle") {
      $("loader-text").textContent = `Przygotowanie sceny: ${status.message}`;
      await sleep(700);
      status = await json("/api/status");
    }
    if (status.state === "error") throw new Error(status.error);
    this.cache = status.cache;
    $("loader-text").textContent = "Wczytywanie profilu i manifestu…";
    const [manifest, profile, locations] = await Promise.all([json("/api/scene/manifest"), json("/api/profile"), json("/api/locations")]);
    this.locations = locations;
    this.model = new SceneModel(manifest, profile);
    this.model.addFeatures([], {});
    this.engine = new Engine($("map"), this.model, { onPick: (id) => this.select(id), onFrame: () => this.onFrame() });
    await this.engine.init();
    this.engine.rig.target.set(0, 0, 90);
    this.top = new TopPanel($("top-panel"), this);
    this.bottom = new BottomPanel($("bottom-panel"), this);
    this.renderAttribution();
    // Dane przychodzą kaflami: najpierw kafel pod kamerą (budowany w tle i zapisywany w cache), potem sąsiednie.
    this.tiles = new TileManager(this);
    while (!this.tiles.loaded.size) {
      await this.tiles.tick();
      const s = this.tiles.status();
      $("loader-text").textContent = s.error ? `Kafle danych: ${s.error}` : `Kafle danych: gotowe ${s.ready}/${s.total}${s.message ? ` · ${s.message}` : ""}`;
      if (!this.tiles.loaded.size) await sleep(1200);
    }
    this.tiles.start();
    await this.engine.terrainReady();
    $("loader").hidden = true;
    $("loader").style.display = "none";
    setInterval(() => this.refreshCache(), 15000);
  }

  /**
   * Zmiana zestawu kafli: obiekty dochodzą, odchodzą albo są zastępowane nowszą wersją; model i widok są przeliczane raz.
   * Zmiany sesyjne zostają (dotyczą identyfikatorów, także obiektów wczytanych ponownie).
   */
  /** regions: zasięgi kafli wczytanych, zwolnionych i zastąpionych (z marginesem terenu); tylko tam widok jest przebudowywany. */
  async applyTiles(add, relations, removeIds, extent, regions = []) {
    const started = performance.now();
    if (this.selected && removeIds.includes(this.selected) && !add.some((f) => f.id === this.selected)) this.select(null, false);
    // Usunięte trasy mogły dopasowywać teren także poza swoim kaflem: ich obrysy trafiają do przeliczenia dopasowania.
    const vanished = removeIds.map((id) => this.model.states.get(id)).filter((s) => s?.feature.geometry === "way" && s.interp.geometry === "line").map((s) => boundsOf(s.feature));
    // Model i widok są przeliczane etapami z przerwą na klatkę; w tym czasie edycja i inspektor czekają (model jest niespójny).
    this.applying = true;
    try {
      let busy = 0, slice = performance.now();
      const pause = async () => { busy += performance.now() - slice; await this.engine.nextFrame(); slice = performance.now(); };
      const { changed } = await this.model.addFeaturesStaged(add, relations, { remove: removeIds }, pause);
      busy += performance.now() - slice;
      const model = Math.round(busy);
      const { chunks, timings } = await this.engine.applyTiles({ changed, removed: removeIds, regions, extent, vanished });
      this.tileTimings = { model, modelSteps: this.model.stageTimings, ...timings, changed: changed.size, chunkCount: chunks };
      this.lastTiles = `${Math.round(performance.now() - started)} ms (model ${model} ms, widok ${timings.busy} ms, w porcjach; kawałki ${chunks}), +${add.length} / −${removeIds.length} obiektów, razem ${this.model.states.size}`;
    } finally {
      this.applying = false;
    }
    this.bottom?.render();
  }

  onTiles(status) {
    this.tileStatus = status;
    this.top?.updateStats();
  }

  renderAttribution() {
    const license = this.model.manifest.sources[0].license;
    $("attribution").replaceChildren(link(license.url, license.attribution), " · ", link(this.model.manifest.sources[1].license.url, this.model.manifest.sources[1].license.attribution));
  }

  async refreshCache() {
    const status = await json("/api/status");
    this.cache = status.cache;
    this.top.updateStats();
  }

  toast(message) {
    const element = $("toast");
    element.textContent = message; element.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { element.hidden = true; }, 4500);
  }

  select(id, openPanel = true) {
    this.selected = id;
    this.engine.setSelected(id);
    if (id && openPanel) this.bottom.open = true;
    // W trakcie przeliczania kafli panel odświeży się po jego zakończeniu.
    if (!this.applying) this.bottom.render();
  }

  /** Jedyna ścieżka edycji: model przelicza zależności, widok przebudowuje tylko dotknięte kawałki. */
  edit(action) {
    if (this.applying) { this.toast("Trwa wczytywanie danych; zmiana nie została zapisana, spróbuj za chwilę."); return null; }
    const started = performance.now();
    const result = this.model.edit(action);
    if (!result) { this.bottom.render(); return null; }
    const chunks = this.engine.applyChanges(result.changed);
    this.lastRecalc = `${Math.round(performance.now() - started)} ms, obiekty ${result.changed.size}, kawałki ${chunks}`;
    if (result.ids[0] && this.model.states.has(result.ids[0]) && result.ids[0] !== this.selected) this.select(result.ids[0]);
    else this.bottom.render();
    return result;
  }

  featureLocation(state) {
    const f = state.feature;
    if (f.point) return f.point;
    if (f.anchor) return f.anchor;
    const i = Math.floor(f.points.length / 6) * 3;
    return [f.points[i], f.points[i + 1], state.level ? state.level.z[i / 3] : f.points[i + 2]];
  }

  openIssue(issue) { this.select(issue.objects[0]); this.engine.focus(issue.location); }
  openFeature(id) { this.select(id); this.engine.focus(this.featureLocation(this.model.states.get(id)), 420); }

  flyToLonLat(lon, lat, label) {
    const { origin } = this.model.manifest, e = this.engine.extent;
    const [east, north] = wgs84ToPl1992(lon, lat);
    const x = east - origin.east, y = north - origin.north;
    // Poza wczytanymi kaflami dane są doczytywane po przelocie (kafel budowany jest w tle przy pierwszej wizycie).
    const inside = Boolean(e) && x >= e[0] && x <= e[2] && y >= e[1] && y <= e[3];
    this.engine.rig.flyTo({ x, y, z: 90, distance: 900, tilt: 0.8 }, 1200);
    if (!inside) this.toast(`${label}: wczytywanie kafli danych w tym miejscu…`);
  }

  async goToOsm(type, id, label) {
    const local = this.model.byOsm.get(`${type}/${id}`);
    if (local) return this.openFeature(local);
    const place = await json(`/api/locate/${type}/${id}`);
    return this.flyToLonLat(place.lon, place.lat, label);
  }

  async goToLocation(location) {
    const [type, id] = location.osm.split("/");
    try { await this.goToOsm(type, id, location.name); } catch (error) { this.toast(`Nie udało się ustalić położenia: ${error.message}`); }
  }

  async search(raw) {
    const query = raw.trim();
    if (!query) return;
    const coordinates = /^(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)$/.exec(query);
    if (coordinates) {
      const lat = Number(coordinates[1]), lon = Number(coordinates[2]);
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return this.toast("Współrzędne poza zakresem. Format: szerokość, długość.");
      return this.flyToLonLat(lon, lat, "Współrzędne");
    }
    const osm = /^(node|way|relation|n|w|r)[\s/]*(\d+)$/i.exec(query);
    if (osm) {
      const type = { n: "node", w: "way", r: "relation" }[osm[1][0].toLowerCase()];
      try { return await this.goToOsm(type, osm[2], `${type} ${osm[2]}`); } catch (error) { return this.toast(`Nie znaleziono obiektu: ${error.message}`); }
    }
    const needle = query.toLocaleLowerCase("pl");
    const place = this.locations.find((l) => l.name.toLocaleLowerCase("pl").includes(needle));
    let best = null;
    for (const state of this.model.states.values()) {
      const name = state.interp.name?.toLocaleLowerCase("pl");
      if (name?.includes(needle) && (!best || state.interp.classDef.tier < best.interp.classDef.tier)) best = state;
    }
    if (best) return this.openFeature(best.feature.id);
    if (place) return this.goToLocation(place);
    return this.toast(`Brak wyników dla „${query}” w załadowanej scenie.`);
  }

  async setCacheLimit(bytes) {
    try { this.cache = await json("/api/cache/limit", { method: "POST", body: JSON.stringify({ bytes: Math.round(bytes) }) }); this.top.updateStats(); this.toast("Zapisano limit cache."); }
    catch (error) { this.toast(error.message); }
  }

  requestRefresh() {
    const { session } = this.model;
    if (!session.hasChanges) return this.runRefresh();
    const dialog = $("dialog");
    dialog.replaceChildren(h("h3", {}, t("refreshTitle")), h("p", {}, t("refreshBody", session.changedFeatureCount())),
      h("div", { class: "dialog-actions" }, h("button", { class: "primary", onclick: () => dialog.close() }, t("stay")),
        h("button", { onclick: () => { dialog.close(); this.discardSession(); this.runRefresh(); } }, t("discard"))));
    return dialog.showModal();
  }

  /** Odrzucenie wszystkich zmian sesyjnych: obiekty wracają do tagów źródłowych bez przeładowania sceny. */
  discardSession() {
    const ids = [...this.model.session.overlays.keys()].filter((id) => this.model.states.has(id));
    this.model.session.discardAll();
    if (ids.length) this.engine.applyChanges(this.model.refresh(ids).changed);
    this.bottom.render();
  }

  /** Odświeżenie źródeł dla kafli widocznych na ekranie: serwer pobiera je ponownie, a gotowa nowa wersja zastępuje starą. */
  async runRefresh() {
    const tiles = this.tiles.visibleTiles();
    if (!tiles.length) return this.toast("Brak wczytanych kafli na ekranie do odświeżenia.");
    try {
      await json("/api/tiles/refresh", { method: "POST", body: JSON.stringify({ tiles }) });
      this.toast(`Odświeżanie źródeł dla ${tiles.length} widocznych kafli… bieżące dane pozostają do czasu gotowości nowych.`);
    } catch (error) {
      this.toast(`Odświeżenie nieudane: ${error.message}`);
    }
    return undefined;
  }

  onFrame() {
    // Ostatnia klatka ruchu też musi odświeżyć etykiety, bo później pętla renderowania stoi.
    clearTimeout(this.uiTimer);
    const now = performance.now();
    const wait = 250 - (now - (this.lastUi ?? 0));
    if (wait > 0) { this.uiTimer = setTimeout(() => this.onFrame(), wait + 10); return; }
    this.lastUi = now;
    this.top.updateStats();
    this.updateLabels();
  }

  updateLabels() {
    const layer = $("labels");
    const { engine, model } = this;
    if (engine.rig.globeBlend > 0) { layer.replaceChildren(); return; }
    const camera = engine.camera.position, placed = [], out = [], seen = new Set();
    const candidates = [];
    for (const state of model.states.values()) {
      const { interp, feature } = state;
      if (!interp.name || feature.geometry === "point" || interp.classDef.render === "extrude" || engine.features.hiddenGroups.has(interp.classDef.group)) continue;
      const at = this.featureLocation(state);
      if (at[2] === null) continue;
      const distance = Math.hypot(at[0] - camera.x, at[1] - camera.y, at[2] - camera.z);
      if (distance < [30000, 5000, 1800, 700][interp.classDef.tier] * this.detail) candidates.push({ state, at, score: interp.classDef.tier * 2000 + distance });
    }
    candidates.sort((a, b) => a.score - b.score);
    for (const { state, at } of candidates) {
      if (out.length >= 40 || seen.has(state.interp.name)) continue;
      const p = engine.project(at[0], at[1], at[2]);
      if (!p || p.x < 0 || p.y < 50 || p.x > innerWidth || p.y > innerHeight - 40) continue;
      const w = state.interp.name.length * 3.6 + 8;
      if (placed.some((q) => Math.abs(q.x - p.x) < q.w + w && Math.abs(q.y - p.y) < 16)) continue;
      placed.push({ ...p, w }); seen.add(state.interp.name);
      out.push(h("div", { class: `map-label ${state.interp.classDef.group === "water" ? "water" : ""}`, style: `left:${p.x}px;top:${p.y}px` }, state.interp.name));
    }
    layer.replaceChildren(...out);
  }

  /** Przejście testowe; wynik zawiera sprzęt i rozdzielczość, bo tylko wtedy można go porównać z celem. */
  async runPerf() {
    const { engine } = this;
    const { rig } = engine;
    const saved = { x: rig.target.x, y: rig.target.y, z: rig.target.z, distance: rig.distance, tilt: rig.tilt, azimuth: rig.azimuth };
    // Gęsta scena to kawałek z największą liczbą obiektów, a nie miejsce wybrane ręcznie.
    const dense = [...engine.features.chunks.values()].sort((a, b) => b.ids.size - a.ids.size)[0];
    const stages = [
      { name: "typowa nawigacja", from: { x: -900, y: 0, distance: 1800, tilt: 0.9, azimuth: 0.2 }, to: { x: 900, y: 500, distance: 1200, tilt: 1, azimuth: 1.1 } },
      { name: `gęsta scena (${dense.ids.size} obiektów w kawałku)`, from: { x: dense.cx - 200, y: dense.cy - 120, distance: 420, tilt: 1.2, azimuth: 2.2 }, to: { x: dense.cx + 200, y: dense.cy + 120, distance: 300, tilt: 1.25, azimuth: 3.2 } },
    ];
    const output = [];
    const gl = engine.renderer.getContext();
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "nieznany";
    engine.continuous = true;
    for (const stage of stages) {
      const times = [];
      let last = 0;
      await new Promise((resolve) => {
        const start = performance.now(), duration = 8000;
        const tick = (now) => {
          if (last) times.push(now - last);
          last = now;
          const t01 = Math.min(1, (performance.now() - start) / duration);
          const mix = (a, b) => a + (b - a) * t01;
          rig.target.set(mix(stage.from.x, stage.to.x), mix(stage.from.y, stage.to.y), 90);
          rig.distance = mix(stage.from.distance, stage.to.distance); rig.tilt = mix(stage.from.tilt, stage.to.tilt); rig.azimuth = mix(stage.from.azimuth, stage.to.azimuth);
          if (t01 >= 1) { engine.frameListeners.delete(tick); resolve(); }
        };
        engine.frameListeners.add(tick);
      });
      times.sort((a, b) => a - b);
      const mean = times.reduce((s, v) => s + v, 0) / times.length;
      const { calls, triangles } = engine.renderer.info.render;
      output.push(`${stage.name}: śr. ${(1000 / mean).toFixed(1)} kl./s; 1% najwolniejszych ${(1000 / times[Math.floor(times.length * 0.99)]).toFixed(1)} kl./s; ${calls} wywołań, ${Math.round(triangles / 1000)} tys. trójkątów`);
    }
    engine.continuous = false;
    rig.flyTo(saved, 400);
    const canvas = engine.renderer.domElement;
    const s = engine.terrain.stats;
    this.perfText = [`Bufor: ${canvas.width}×${canvas.height}`, `GPU: ${gpu}`, ...output, `Teren: pierwsze pokrycie ${s.firstCoverMs} ms, kafle ${s.loaded}`, `Pamięć JS: ${performance.memory ? `${Math.round(performance.memory.usedJSHeapSize / 1e6)} MB` : "brak danych"}`].join("\n");
    this.perfResult = this.perfText;
    this.top.open = true;
    this.top.render();
    return this.perfText;
  }
}

const app = new App();
window.app = app;
app.start().catch((error) => {
  console.error(error);
  $("loader").hidden = false;
  $("loader").style.display = "";
  $("loader-text").textContent = `Nie udało się uruchomić aplikacji: ${error.message}`;
});
