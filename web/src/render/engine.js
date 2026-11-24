// Składa scenę Three.js: globus, teren, obiekty, znaczniki diagnostyki, wybór i pętlę renderowania.
import * as THREE from "three";
import { CameraRig, EARTH_RADIUS, GLOBE_CENTER } from "./camera.js";
import { boundsOf } from "../core/model.js";
import { FeatureRenderer } from "./features.js";
import { vegetationGroundPositions } from "./vegetation.js";
import { AreaOverlay } from "./overlay.js";
import { globeMaterial, MAX_CUTS, pointMaterial, sharedUniforms, skyMaterial, terrainMaterial } from "./shaders.js";
import { conformsTerrain, GroundConform } from "./groundConform.js";
import { loadGroundSampler, TerrainSystem } from "./terrain.js";

export const MARKER_STYLE = {
  physical: { color: "#d8343c", shape: 0 }, context: { color: "#e77c12", shape: 3 },
  missing: { color: "#2f74d0", shape: 2 }, uncertain: { color: "#8348c4", shape: 1 },
};

function fullscreenTriangle(material) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}

async function landTexture() {
  const topo = await (await fetch("/vendor/land-110m.json")).json();
  const { scale, translate } = topo.transform;
  const arcs = topo.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * scale[0] + translate[0], y * scale[1] + translate[1]]; });
  });
  const canvas = document.createElement("canvas");
  canvas.width = 2048; canvas.height = 1024;
  const c = canvas.getContext("2d");
  c.fillStyle = "#000"; c.fillRect(0, 0, 2048, 1024); c.fillStyle = "#fff";
  const ring = (path, indexes) => {
    let first = true;
    for (const index of indexes) {
      const arc = index >= 0 ? arcs[index] : [...arcs[~index]].reverse();
      for (const [lon, lat] of arc) {
        const x = ((lon + 180) / 360) * 2048, y = ((lat + 90) / 180) * 1024;
        if (first) { path.moveTo(x, y); first = false; } else path.lineTo(x, y);
      }
    }
    path.closePath();
  };
  const path = new Path2D();
  const add = (g) => {
    if (g.type === "GeometryCollection") g.geometries.forEach(add);
    else if (g.type === "Polygon") g.arcs.forEach((r) => ring(path, r));
    else if (g.type === "MultiPolygon") g.arcs.forEach((p) => p.forEach((r) => ring(path, r)));
  };
  Object.values(topo.objects).forEach(add);
  c.fill(path, "evenodd");
  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false; texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  return texture;
}

function tangentFrame({ lon, lat, gridConvergenceDegrees: gamma }) {
  const l = THREE.MathUtils.degToRad(lon), p = THREE.MathUtils.degToRad(lat), g = THREE.MathUtils.degToRad(gamma);
  const east = new THREE.Vector3(-Math.sin(l), Math.cos(l), 0);
  const north = new THREE.Vector3(-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p));
  const up = new THREE.Vector3(Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p));
  const gridEast = east.clone().multiplyScalar(Math.cos(g)).addScaledVector(north, -Math.sin(g));
  const gridNorth = north.clone().multiplyScalar(Math.cos(g)).addScaledVector(east, Math.sin(g));
  return { matrix: new THREE.Matrix3().set(gridEast.x, gridNorth.x, up.x, gridEast.y, gridNorth.y, up.y, gridEast.z, gridNorth.z, up.z), up };
}

// Odnowienie wyboru najbliższych wycięć tuneli po przesunięciu celu kamery o tyle metrów.
// Porcja przebudowy kawałków w jednej klatce przy doczytaniu kafli (ms).
const CHUNK_SLICE_MS = 25;
// Czas na klatkę na wysyłanie nowych siatek na GPU w tle (ms).
const PRIME_BUDGET_MS = 4;
// Budżet budowy roślinności na klatkę (obliczenie położeń i siatek instancji jednego lub kilku kwadratów 250 m).
const VEGETATION_BUDGET_MS = 4;
// Kamera uznana za nieruchomą po tylu milisekundach bez zmiany położenia, odległości i kierunku.
const CALM_MS = 400;
// Pas wpływu dopasowania wokół zmienionej trasy: połowa szerokości (do ok. 25 m) i rdzeń z wygładzeniem (8 m).
const CONFORM_MARGIN_METERS = 40;
const CUT_REFRESH_METERS = 150;

export class Engine {
  constructor(container, model, callbacks) {
    Object.assign(this, { container, model, callbacks });
    // Bufor szablonu: oznakowanie jezdni jest rysowane tylko tam, gdzie widać nawierzchnię, na której leży.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", stencil: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setClearColor(0xe6edf0, 1);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 100000);
    this.shared = sharedUniforms();
    this.dirty = true;
    this.continuous = false;
    this.frameListeners = new Set();
    this.rig = new CameraRig(this.camera, this.renderer.domElement, () => this.invalidate(), (x, y) => this.pick(x, y));
    this.pickTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
    this.frustum = new THREE.Frustum();
    this.markerVisible = true;
    this.markerFilter = new Set(Object.keys(MARKER_STYLE));
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  async init() {
    const { manifest } = this.model;
    const low = 70, high = 125;
    this.shared.uZ0.value = low;
    this.sky = fullscreenTriangle(skyMaterial(this.shared));
    this.sky.renderOrder = -20;
    this.scene.add(this.sky);
    this.overlay = new AreaOverlay(this.model, manifest.terrainExtent, manifest.polygon);
    this.conform = new GroundConform(manifest.terrainExtent);
    this.terrainMaterial = terrainMaterial(this.shared, this.overlay.texture, manifest.terrainExtent, [low, high], this.conform.texture, this.overlay.maskTexture);
    this._bindConform();
    this.terrain = new TerrainSystem(manifest.tiles, this.terrainMaterial, () => this.invalidate());
    this.rig.heightAt = (x, y) => this.terrain.heightAt(x, y);
    this.features = new FeatureRenderer(this.model, this.shared);
    // Dane geometrii są w pamięci JS zwalniane po wysłaniu na GPU, więc po odzyskaniu kontekstu WebGL widok i teren
    // są budowane od nowa.
    this.renderer.domElement.addEventListener("webglcontextrestored", () => { this.terrain.reset(); this.rebuildAll(); });
    // Posadzka przy ścianach oporowych jest rysowana materiałem terenu, więc ma jego kolor i fakturę.
    this.features.materials.wallFloor = this.terrainMaterial;
    this.local = new THREE.Group();
    this.local.add(this.terrain.group, this.features.group);
    this.scene.add(this.local);
    this.overlay.redraw();

    const frame = tangentFrame(manifest.origin);
    this.globe = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS, 128, 96), globeMaterial(this.shared, await landTexture(), frame.matrix, frame.up));
    this.globe.position.copy(GLOBE_CENTER);
    this.globe.renderOrder = -10;
    this.scene.add(this.globe);
    this.markers = new THREE.Points(new THREE.BufferGeometry(), pointMaterial(this.shared, { depthTest: false }));
    this.markers.renderOrder = 90;
    this.markers.frustumCulled = false;
    this.local.add(this.markers);
    this.invalidate();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  invalidate() { this.dirty = true; }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.shared.uPxScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.rig.apply();
    this.invalidate();
  }

  setSelected(id) {
    const value = this.shared.uSelected.value;
    if (id) value.fromArray(this.features.pickColor(id)); else value.set(-1, -1, -1);
    this._updateMarkers();
    this.invalidate();
  }

  _updateMarkers() {
    const position = [], colors = [], picks = [], sizes = [], shapes = [], ranges = [];
    const c = new THREE.Color();
    if (this.markerVisible) {
      for (const issue of this.model.diagnostics.issues) {
        if (!this.markerFilter.has(issue.category) || issue.location[2] === null) continue;
        const style = MARKER_STYLE[issue.category];
        c.setStyle(style.color, THREE.LinearSRGBColorSpace);
        position.push(issue.location[0], issue.location[1], issue.location[2] + 3);
        colors.push(c.r, c.g, c.b);
        picks.push(...this.features.pickColor(issue.objects[0]));
        sizes.push(8 + issue.severity * 2);
        shapes.push(style.shape + (issue.status === "potwierdzona" ? 0 : 0.5));
        // Drobne uwagi o danych są widoczne z bliska, aby nie zasłaniały kolizji w widoku ogólnym.
        ranges.push(issue.status === "informacja" && issue.severity === 1 ? 900 : 0);
      }
    }
    const g = this.markers.geometry;
    g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    g.setAttribute("aColor", new THREE.Float32BufferAttribute(colors, 3));
    g.setAttribute("aPick", new THREE.Float32BufferAttribute(picks, 3));
    g.setAttribute("aSize", new THREE.Float32BufferAttribute(sizes, 1));
    g.setAttribute("aShape", new THREE.Float32BufferAttribute(shapes, 1));
    g.setAttribute("aRange", new THREE.Float32BufferAttribute(ranges, 1));
  }

  /** Przebudowa widoku po edycji bez przeładowania sceny. */
  applyChanges(ids) {
    let areas = false;
    for (const id of ids) {
      const state = this.model.states.get(id);
      const raised = Boolean(state.level?.lifted && state.level.units > 0);
      if (state.feature.geometry !== "point" && (state.interp.geometry === "area" || state.feature.closed || raised || state.castShadow)) areas = true;
      state.castShadow = raised;
    }
    const chunks = this.features.refresh(ids);
    this._updateCuts();
    this._updateWallCut();
    if (areas) this.overlay.redraw();
    this._scheduleConform(this._conformRegions(ids));
    this._updateMarkers();
    this.invalidate();
    return chunks;
  }

  /** Czeka na pierwsze pokrycie terenem, aby scena nie pokazała się częściowo wczytana. */
  async terrainReady(timeoutMs = 4000) {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      if (this.terrain.stats.firstCoverMs !== null && this.terrain.settled) return;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }

  /** Bariery, podpory, tunele i roślinność potrzebują wysokości rysowanego terenu także między węzłami: bariera na nim stoi, a tunel jest nim przykryty. */
  async _loadGround() {
    const positions = [], lines = [];
    for (const plan of this.model.barriers.byId.values()) {
      if (plan.kind === "node") { positions.push(plan.x, plan.y); continue; }
      const { points } = this.model.states.get(plan.id).feature;
      lines.push(points);
    }
    for (const s of this.model.supports?.items ?? []) positions.push(s.x, s.y);
    for (const plan of this.model.tunnels?.byId.values() ?? []) lines.push(this.model.states.get(plan.id).feature.points);
    // Ściany budynków zaczynają się na rysowanym terenie wzdłuż całego obrysu.
    for (const state of this.model.states.values()) {
      if (state.interp.classDef.render !== "extrude" || state.interp.geometry !== "area") continue;
      const f = state.feature;
      if (f.geometry === "multipolygon") for (const rings of f.polygons) for (const ring of rings) lines.push(ring.flatMap((v, i) => (i % 2 ? [v, 0] : [v])));
      else if (f.points) lines.push(f.points);
    }
    // Drzewa stoją na rysowanym terenie: pojedyncze, w szpalerach i w całym wnętrzu lasów i zarośli.
    if (this.model.profile.vegetation) vegetationGroundPositions(this.model, positions, lines);
    for (const points of lines) {
      for (let i = 3; i < points.length; i += 3) {
        const parts = Math.max(1, Math.ceil(Math.hypot(points[i] - points[i - 3], points[i + 1] - points[i - 2]) / 16));
        for (let k = 0; k <= parts; k += 1) positions.push(points[i - 3] + ((points[i] - points[i - 3]) * k) / parts, points[i - 2] + ((points[i + 1] - points[i - 2]) * k) / parts);
      }
    }
    this.groundGrids ??= new Map();
    const terrainAt = await loadGroundSampler(this.model.manifest.tiles, positions, this.model.manifest.tiles.maxLevel, this.groundGrids);
    this.terrainAt = terrainAt;
    this.features.terrainAt = terrainAt;
    this.features.groundAt = (x, y) => { const base = terrainAt(x, y); return base === null ? null : this.conform.ground(x, y, base); };
  }

  /**
   * Doczytane lub zwolnione kafle danych. Przeliczane są tylko zmienione obszary (regions: zasięgi kafli wczytanych,
   * zwolnionych i zastąpionych nowszą wersją) oraz obiekty ze zmienionym planem (changed): dopasowanie terenu w tych
   * obszarach i kawałki widoku z tymi obiektami. Reszta widoku zostaje bez zmian.
   */
  async applyTiles({ changed, removed, regions, extent, vanished = [] }) {
    const timings = {};
    let clock = performance.now(), busy = 0, slice = performance.now();
    const lap = (name) => { const now = performance.now(); timings[name] = Math.round(now - clock); clock = now; };
    // Przerwa na klatkę między ciężkimi krokami; `busy` liczy tylko czas pracy (bez oczekiwania na klatkę i sieć).
    const steps = {};
    const pause = async (label = "kawałki") => { const d = performance.now() - slice; busy += d; steps[label] = Math.max(steps[label] ?? 0, Math.round(d)); await this.nextFrame(); slice = performance.now(); };
    timings.steps = steps;
    const e = this.extent;
    if (extent && (!e || extent.some((v, i) => Math.abs(v - e[i]) > 1))) { this.setExtent(extent, []); await pause("zasięg"); }
    // Pas nowej siatki dopasowania: teren pod obiektami zmienił się, więc są przebudowywane jak w zmienionym obszarze.
    regions = [...regions, ...(this.conformFresh ?? [])];
    this.conformFresh = [];
    this.forgetGround(regions);
    this._dropGroundOutside(this.extent);
    busy += performance.now() - slice;
    await this._loadGround();
    slice = performance.now();
    lap("ground");
    this.features.invalidateCaches();
    this._updateCuts();
    await pause("wycięcia");
    for (const label of this.features.warmSteps()) await pause(label);
    const m = CONFORM_MARGIN_METERS, gone = vanished.map(([x0, y0, x1, y1]) => [x0 - m, y0 - m, x1 + m, y1 + m]);
    const walls = this._wallStamps();
    await pause("profile ścian");
    for (const label of this.conform.updateSteps(this.model, (state) => this.features.axisOf(state), [...regions, ...gone, ...this._conformRegions(changed)], walls)) await pause(label);
    lap("conform");
    await pause("dopasowanie");
    // Kawałki są przebudowywane porcjami między klatkami (kamera reaguje w trakcie): najpierw puste (usunięte obiekty
    // znikają od razu), potem od najbliższych celu kamery.
    const keys = [...this.features.update(changed, removed, regions)], target = this.rig.target;
    await pause("przydział");
    const rank = (key) => { const c = this.features.chunks.get(key); return !c ? -2 : !c.ids.size ? -1 : Math.hypot(c.cx - target.x, c.cy - target.y); };
    keys.sort((a, b) => rank(a) - rank(b));
    const chunksStart = busy + performance.now() - slice;
    for (const key of keys) {
      this.features.rebuildChunk(key);
      if (performance.now() - slice > CHUNK_SLICE_MS) { this.invalidate(); await pause(); }
    }
    const chunks = keys.length;
    timings.chunksBusy = Math.round(busy + performance.now() - slice - chunksStart);
    await pause();
    this._updateWallCut();
    lap("chunks");
    await pause("cięcie przy ścianach");
    this._updateMarkers();
    this.overlay.redraw();
    lap("overlay");
    steps["nakładka"] = Math.round(performance.now() - slice);
    busy += performance.now() - slice;
    timings.busy = Math.round(busy);
    this.invalidate();
    return { chunks, timings };
  }

  /**
   * Ściany oporowe dla dopasowania terenu: punkty profilu ściany i jej dół, ten sam co dół lica i posadzki (teren po niższej
   * stronie, trasy przy ścianie). Dzięki temu teren za pasem posadzki schodzi do tej samej wysokości i na granicy pasa
   * nie powstaje uskok.
   */
  _wallStamps() {
    if (!this.terrainAt) return [];
    const out = [];
    for (const plan of this.model.barriers?.byId.values() ?? []) {
      if (!this.features.retainingCuts(plan)) continue;
      const lower = this.features.retainingSide(plan).lower;
      for (const rows of this.features.barrierProfile(this.model.states.get(plan.id), plan)) {
        if (rows.length > 1) out.push({ xs: rows.map((r) => r.x), ys: rows.map((r) => r.y), lows: rows.map((r) => r.base), lower });
      }
    }
    return out;
  }

  /**
   * Wysyła na GPU siatki, których jeszcze nie narysowano (poza kadrem albo poza zasięgiem szczegółowości): każda jest raz
   * rysowana do ukrytego celu 1×1 piksel. Dane wierzchołków trafiają na GPU, shader jest kompilowany, a kopia w pamięci JS
   * zostaje zwolniona (releaseArray). Najwyżej PRIME_BUDGET_MS na klatkę.
   */
  _primeMeshes() {
    const started = performance.now();
    this.primeTarget ??= new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, stencilBuffer: true });
    const target = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.primeTarget);
    for (const list of [this.terrain.unuploaded, this.features.unuploaded]) while (list.length && performance.now() - started < PRIME_BUDGET_MS) {
      const mesh = list.pop();
      if (!mesh.parent) continue;
      const { visible, frustumCulled } = mesh;
      mesh.visible = true; mesh.frustumCulled = false;
      this.renderer.render(mesh, this.camera);
      mesh.visible = visible; mesh.frustumCulled = frustumCulled;
    }
    this.renderer.setRenderTarget(target);
  }

  /** Następna klatka; w karcie w tle requestAnimationFrame nie działa, więc wtedy wystarcza krótka przerwa. */
  nextFrame() {
    return new Promise((resolve) => { const timer = setTimeout(resolve, 100); requestAnimationFrame(() => { clearTimeout(timer); setTimeout(resolve, 0); }); });
  }

  /** Kamera stoi (bez ruchu od CALM_MS): wtedy można przeliczać doczytane dane bez przycinania ruchu. */
  get calm() { return performance.now() - (this.lastMotion ?? 0) > CALM_MS; }

  /** Obszary dopasowania terenu wokół tras o podanych identyfikatorach (pas wpływu z zapasem na zmianę szerokości). */
  _conformRegions(ids) {
    const regions = [];
    for (const id of ids) {
      const state = this.model.states.get(id);
      if (!state || state.feature.geometry !== "way" || !(conformsTerrain(state) || this.model.barriers?.byId.get(id)?.retaining)) continue;
      const [x0, y0, x1, y1] = boundsOf(state.feature), margin = CONFORM_MARGIN_METERS;
      regions.push([x0 - margin, y0 - margin, x1 + margin, y1 + margin]);
    }
    return regions;
  }

  /** Nowe dane wysokości w podanych zasięgach: kafle wysokości pod bariery i podpory z tych miejsc są pobierane ponownie. */
  forgetGround(extents) {
    if (!this.groundGrids) return;
    const { rootSize, maxLevel } = this.model.manifest.tiles, size = rootSize / 2 ** maxLevel;
    const rootWest = this.model.manifest.tiles.rootWest ?? -rootSize / 2, rootSouth = this.model.manifest.tiles.rootSouth ?? -rootSize / 2;
    for (const key of [...this.groundGrids.keys()]) {
      const [x, y] = key.split("/").map(Number), west = rootWest + x * size, south = rootSouth + y * size;
      if (extents.some((e) => west <= e[2] && west + size >= e[0] && south <= e[3] && south + size >= e[1])) this.groundGrids.delete(key);
    }
  }

  /** Siatki wysokości pod bariery poza bieżącym zasięgiem danych nie są potrzebne: zwalniane (w razie potrzeby pobierane ponownie). */
  _dropGroundOutside(extent) {
    if (!this.groundGrids || !extent) return;
    const { rootSize, maxLevel } = this.model.manifest.tiles, size = rootSize / 2 ** maxLevel;
    const rootWest = this.model.manifest.tiles.rootWest ?? -rootSize / 2, rootSouth = this.model.manifest.tiles.rootSouth ?? -rootSize / 2;
    for (const key of [...this.groundGrids.keys()]) {
      const [x, y] = key.split("/").map(Number), west = rootWest + x * size, south = rootSouth + y * size;
      if (west > extent[2] || west + size < extent[0] || south > extent[3] || south + size < extent[1]) this.groundGrids.delete(key);
    }
  }

  /**
   * Zasięg danych zmienił się (wczytane lub zwolnione kafle): nakładka obszarów, dopasowanie terenu i maska tuneli
   * obejmują nowy zasięg; kafle terenu są pobierane od nowa, bo serwer ma nowe dane wysokości.
   */
  setExtent(extent, polygon) {
    this.extent = extent;
    this.overlay = new AreaOverlay(this.model, extent, polygon);
    for (const group of this.features.hiddenGroups) this.overlay.hiddenGroups.add(group);
    // Dopasowanie terenu przejmuje część wspólną z poprzedniej siatki; nowe obszary stempluje applyTiles.
    const previous = this.conform;
    this.conform = new GroundConform(extent, previous);
    // Nowa część siatki (poza poprzednią) ma puste dopasowanie także pod zachowanymi kaflami: trafia do przeliczenia.
    this.conformFresh = [...(this.conformFresh ?? []), ...this.conform.uncovered(previous)];
    previous.texture.dispose(); previous.maskTexture.dispose(); previous.wallIndexTexture.dispose(); previous.wallDataTexture?.dispose();
    const u = this.terrainMaterial.uniforms;
    u.uOverlay.value = this.overlay.texture; u.uMask.value = this.overlay.maskTexture;
    u.uExtent.value.set(extent[0], extent[1], extent[2] - extent[0], extent[3] - extent[1]);
    this._bindConform();
    this.terrain.dataExtent = extent;
    this.terrain.reset();
  }

  /** Cięcie terenu przy ścianach oporowych: indeks odcinków na siatce dopasowania i ich dane dla shadera terenu. */
  _updateWallCut() {
    this.conform.stampWallCut(this.features.retainingCutSegments());
    const u = this.terrainMaterial.uniforms;
    u.uWallIndex.value = this.conform.wallIndexTexture; u.uWallData.value = this.conform.wallDataTexture; u.uWallCount.value = this.conform.wallCount;
  }

  _bindConform() {
    const c = this.conform.extent;
    if (this.terrainMaterial) {
      const u = this.terrainMaterial.uniforms;
      // Nowa siatka dopasowania: cięcie przy ścianach działa od kolejnego _updateWallCut (do tego czasu bez cięcia).
      u.uConform.value = this.conform.texture; u.uWallIndex.value = this.conform.wallIndexTexture; u.uWallData.value = this.conform.wallDataTexture; u.uWallCount.value = this.conform.wallCount;
    }
    this.shared.uTunnelMask.value = this.conform.maskTexture;
    this.shared.uTunnelExtent.value.set(c[0], c[1], c[2] - c[0], c[3] - c[1]);
  }

  /** Dopasowanie terenu po edycji: tylko wokół zmienionych tras, zebrane z kolejnych edycji w ciągu 200 ms. */
  _scheduleConform(regions) {
    clearTimeout(this.conformTimer);
    this.conformPending = [...(this.conformPending ?? []), ...regions];
    this.conformTimer = setTimeout(() => {
      const pending = this.conformPending;
      this.conformPending = [];
      if (pending.length) this.conform.update(this.model, (state) => this.features.axisOf(state), pending, this._wallStamps());
      this.invalidate();
    }, 200);
  }

  /** Obrysy tub tuneli dla shaderów terenu i brył; nadmiar ponad limit jest liczony w kontroli. */
  _updateCuts(stamp = true) {
    // Przy wielu kafelkach odcinków jest więcej niż miejsc w shaderze: trafiają tam najbliższe celu kamery (odnawiane przy ruchu).
    const target = this.rig.target, all = this.model.tunnels?.cuts ?? [];
    const distance = (c) => Math.hypot((c.ax + c.bx) / 2 - target.x, (c.ay + c.by) / 2 - target.y);
    const cuts = all.length > MAX_CUTS ? [...all].sort((a, b) => distance(a) - distance(b)) : all;
    this.cutCenter = { x: target.x, y: target.y };
    const count = Math.min(cuts.length, MAX_CUTS), { uCutA, uCutB, uCutCount } = this.shared;
    for (let i = 0; i < count; i += 1) { const c = cuts[i]; uCutA.value[i].set(c.ax, c.ay, c.bx, c.by); uCutB.value[i].set(c.za, c.zb, c.top, c.half); }
    uCutCount.value = count; this.cutOverflow = cuts.length - count;
    // Maska tuneli (bez limitu) obejmuje wszystkie tunele; przy ruchu kamery zmienia się tylko lista dla shadera.
    if (stamp) this.conform.stampTunnels(all);
  }

  /** Pełna przebudowa widoku (wszystkie kawałki i całe dopasowanie terenu); odniesienie do sprawdzania przebudowy przyrostowej. */
  rebuildAll() {
    this.conformFresh = [];
    this.features.invalidateCaches();
    this._updateCuts();
    this.conform.rebuild(this.model, (state) => this.model.surfaces?.byId.get(state.feature.id)?.axis ?? state.feature.points, this._wallStamps());
    this.features.addAll();
    this._updateWallCut();
    this._updateMarkers();
    this.overlay.redraw();
    this.invalidate();
  }

  setGroupVisible(group, visible) {
    this.features.setGroupVisible(group, visible);
    if (visible) this.overlay.hiddenGroups.delete(group); else this.overlay.hiddenGroups.add(group);
    this.overlay.redraw();
    this.invalidate();
  }

  setDetail(value) { this.terrain.detail = value; this.features.detail = value; this.shared.uDetail.value = value; this.invalidate(); }
  setExaggeration(value) { this.shared.uExag.value = value; this.invalidate(); }
  setRelief(on) { this.terrainMaterial.uniforms.uRelief.value = on ? 1 : 0; this.invalidate(); }
  setMarkers(visible, filter) { this.markerVisible = visible; this.markerFilter = filter; this._updateMarkers(); this.invalidate(); }

  pick(clientX, clientY) {
    const box = this.renderer.domElement.getBoundingClientRect();
    const w = this.renderer.domElement.width, h = this.renderer.domElement.height;
    const x = Math.floor(((clientX - box.left) / box.width) * w), y = Math.floor(((clientY - box.top) / box.height) * h);
    this.camera.setViewOffset(w, h, x, y, 1, 1);
    this.shared.uPick.value = 1;
    this.renderer.setRenderTarget(this.pickTarget);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    const pixel = new Uint8Array(4);
    this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, 1, 1, pixel);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(0xe6edf0, 1);
    this.shared.uPick.value = 0;
    this.camera.clearViewOffset();
    this.invalidate();
    let id = this.features.featureFromPick(pixel[0] | (pixel[1] << 8) | (pixel[2] << 16));
    // Siatka obiektu usuniętego razem z kaflem może być jeszcze widoczna, dopóki jej kawałek czeka na przebudowę.
    if (id && !this.model.states.has(id)) id = null;
    if (!id && this.rig.globeBlend === 0) {
      const ground = this.rig.groundPoint(clientX, clientY);
      if (ground) id = this.overlay.pick(ground.x, ground.y);
    }
    this.callbacks.onPick(id);
    return id;
  }

  project(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    return { x: ((v.x + 1) / 2) * this.container.clientWidth, y: ((1 - v.y) / 2) * this.container.clientHeight };
  }

  focus(location, distance = 320) {
    this.rig.flyTo({ x: location[0], y: location[1], z: location[2] ?? this.rig.target.z, distance, tilt: 0.85 });
  }

  _loop(now) {
    requestAnimationFrame(this._loop);
    const flying = this.rig.update(now);
    // Nowe siatki są wysyłane na GPU w tle (także gdy obraz stoi), aby pierwsze narysowanie w ruchu nie przycinało klatki.
    // Roślinność jest budowana porcjami (od najbliższych celu kamery); nowe siatki wymagają przerysowania.
    if (this.features?.vegetationQueue.length && this.features.buildVegetation(VEGETATION_BUDGET_MS, this.rig.target.x, this.rig.target.y)) this.invalidate();
    if (this.features?.unuploaded.length || this.terrain?.unuploaded.length) this._primeMeshes();
    if (!(this.dirty || flying || this.continuous)) return;
    // Wybór najbliższych wycięć tuneli nadąża za kamerą.
    if ((this.model.tunnels?.cuts.length ?? 0) > MAX_CUTS && this.cutCenter && Math.hypot(this.rig.target.x - this.cutCenter.x, this.rig.target.y - this.cutCenter.y) > CUT_REFRESH_METERS) this._updateCuts(false);
    this.dirty = false;
    // Ruch kamery: znacznik czasu do wstrzymania przeliczeń doczytanych danych podczas przelotu.
    const r = this.rig, pose = [r.target.x, r.target.y, r.distance, r.tilt, r.azimuth];
    if (!this.lastPose || pose.some((v, i) => Math.abs(v - this.lastPose[i]) > (i < 3 ? 0.05 : 1e-4))) { this.lastMotion = performance.now(); this.lastPose = pose; }
    this.rig.apply();
    this.local.visible = this.rig.distance < 500000;
    const blend = this.rig.globeBlend;
    const { uniforms: globe } = this.globe.material;
    globe.uMarkerOn.value = this.rig.distance > 300000 ? 1 : 0;
    globe.uNear.value = 1 - Math.min(1, this.rig.distance / 120000);
    this.sky.material.uniforms.uSpace.value = blend;
    this.shared.uFogRange.value = Math.max(9000, this.rig.distance * 7);
    this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    if (this.local.visible) {
      this.terrain.update(this.camera.position, this.frustum);
      this.drawnChunks = this.features.updateLod(this.camera.position);
    }
    this.renderer.render(this.scene, this.camera);
    for (const listener of this.frameListeners) listener(now);
    this.callbacks.onFrame?.();
  }
}
