// Geometria obiektów w kawałkach siatki: po edycji przebudowywane są tylko dotknięte kawałki.
// Łączenia wynikają wyłącznie ze wspólnych węzłów OSM; trasy leżące blisko siebie nie są sklejane.
import * as THREE from "three";
import { pointInRing } from "../core/diagnostics.js";
import { boundsOf } from "../core/model.js";
import { RETAINING_PROBE_METERS } from "../core/barriers.js";
import { WALL_BAND_METERS } from "./groundConform.js";
import { roofModel } from "./roofs.js";
import { clearanceIndex, plantsOf, vegetationCells, VegetationLayer } from "./vegetation.js";
import { ENTRANCE, FLOODLIGHT, Furniture, LAMP, PITCH, POLE, POWER_LINE, TRACK } from "./furniture.js";
import { stairPoint } from "../core/steps.js";
import { laneOffset, transitionWidthAt } from "../core/surfaces.js";
import { BARRIER_PATTERNS, barrierMaterial, wireMaterial, pointMaterial, ribbonMaterial, solidMaterial, stairMaterial, STAIR_PATTERNS, surfaceRibbonMaterial } from "./shaders.js";

const CHUNK = 500;
const TIER_RANGE = [Infinity, 7000, 2800, 1100];
const SUPPORT_CHUNK = "supports";
const CASING_GROW = 0.6, CASING_GROW_PX = 1.1;
// Linia krawędziowa jest rysowana punktami co 2 m i w wierzchołkach osi.
const EDGE_LINE_STEP_METERS = 2, EDGE_LINE_MIN_METERS = 1;
const TAPER_METERS = 22;
const MIN_CONTINUATION_COS = 0.5, COVER_CELL_METERS = 20, COVER_LEVEL_METERS = 1, COVER_GAP_METERS = 0.3, COVER_MAX_EXTRA_METERS = 6, MAX_DRAW_LAYERS = 4, DECK_LAYER_METERS = 0.03, MAX_DECK_LAYERS = 2, DECK_CASING_DROP_METERS = 0.08, MAX_WIDTH_RATIO = 2.5, MIN_FLUSH_SINE = 0.7, MIN_FILL_METERS = 0.5;
const SHARP_JOIN_COS = 0.75, MIN_WALL_HEIGHT = 0.25, EMBANKMENT_OFFSET = 0.4, PATH_EMBANKMENT_METERS = 15;
const PLATE_EDGE_METERS = 5, PLATE_CELL = 25, PLATE_SAMPLE_METERS = 3, PLATE_ROUTE_MARGIN_METERS = 3, PLATE_LEVEL_RANGE_METERS = 2.5, PLATE_BELOW_ROUTES_METERS = 0.2;
const ROUTE_COLOURS = { red: "#d9534f", blue: "#3f7fcf", green: "#3fa35b", yellow: "#efc22f", black: "#3a3a42", czerwony: "#d9534f", niebieski: "#3f7fcf", zielony: "#3fa35b", "żółty": "#efc22f", czarny: "#3a3a42" };
const color = new THREE.Color();
const rgb = (hex) => { color.setStyle(hex, THREE.LinearSRGBColorSpace); return [color.r, color.g, color.b]; };
const mixColor = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/**
 * Po wysłaniu na GPU kopia danych wierzchołków w pamięci JS nie jest już potrzebna (obwiednia jest liczona wcześniej,
 * a kontrole budują geometrię od nowa): zwolnienie jej zmniejsza stertę o kilkaset MB i odśmiecanie przy ruchu.
 */
export function releaseArray() { this.array = null; }

class Buffers {
  constructor(kind, range) { this.kind = kind; this.range = range; this.index = []; this.count = 0; this.a = {}; }
  push(name, ...values) { (this.a[name] ??= []).push(...values); }
}

const ITEM_SIZE = { position: 3, normal: 3, aPick: 3, aColor: 3, aAccent: 3, aMiter: 2, aUv: 2 };
const MARKING_GROUP = "roadMarkings";
// Bufor szablonu: piksel, w którym widać nawierzchnię na gruncie (przeszła test głębi), dostaje wartość 1.
// Oznakowanie jezdni na gruncie jest rysowane tylko w takich pikselach, więc znika razem z zakrytą nawierzchnią
// (pod terenem, bryłą, nasypem), zamiast wisieć w powietrzu.
const ROAD_STENCIL = 1, OTHER_STENCIL = 2;
const marksVisibleRoad = (material) => Object.assign(material, { stencilWrite: true, stencilRef: ROAD_STENCIL, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp, stencilZFail: THREE.KeepStencilOp, stencilFail: THREE.KeepStencilOp });
const clearsVisibleRoad = (material) => Object.assign(material, { stencilWrite: true, stencilRef: OTHER_STENCIL, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp, stencilZFail: THREE.KeepStencilOp, stencilFail: THREE.KeepStencilOp });
const onVisibleRoad = (material) => Object.assign(material, { stencilWrite: true, stencilRef: ROAD_STENCIL, stencilFunc: THREE.EqualStencilFunc, stencilWriteMask: 0x00, stencilZPass: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilFail: THREE.KeepStencilOp });
const BARRIER_STEP_METERS = 1, BARRIER_SMOOTH_PASSES = 6, BARRIER_SMOOTH_METERS = 2, BARRIER_SINK_METERS = 0.1, BARRIER_POST_METERS = 0.14;
// Bariera na konstrukcji stoi na pomoście albo płycie mostu, gdy leży nie dalej niż tyle od krawędzi jezdni lub obrysu mostu.
const BARRIER_DECK_REACH_METERS = 2.5;
// Zasięg przęsła bariery nad trasą przechodzącą pod nią: najwyższe podłoże do tylu metrów po obu stronach przecięcia.
const BARRIER_SHOULDER_METERS = 30;
// Ściana oporowa: najmniejszy uskok terenu, przy którym lico sięga terenu po wyższej stronie, i wygładzenie góry wzdłuż ściany.
const RETAINING_MIN_STEP_METERS = 0.3, RETAINING_SMOOTH_METERS = 2, RETAINING_LOW_WINDOW_METERS = 3;
// Strona niższa ściany oporowej z NMT: średnia różnica terenu po obu stronach (2,5 m od osi), od której teren rozstrzyga kierunek.
const RETAINING_SIDE_PROBE_METERS = 2.5, RETAINING_CLEAR_STEP_METERS = 0.5;
// Trasa przy ścianie obniża jej dół najwyżej o tyle poniżej terenu po niższej stronie (jak wypełnianie dołków NMT pod trasami).
const RETAINING_ROUTE_DROP_METERS = 2.5;
const RETAINING_SIDES = new WeakMap();
const BARRIER_GROUND_TOLERANCE = 0.2, BARRIER_TOLERANCE_RATIO = 0.2, BARRIER_SUPPORT_JUMP = 0.3, BARRIER_SIMPLIFY_METERS = 0.03, BARRIER_MAX_RUN_METERS = 8, BARRIER_MAX_BEND_METERS = 0.3;
const STRUCTURE_DEPTH_PUSH_METERS = 0.75, SUPPORT_SINK_METERS = 0.1;
// Odstęp kolejności między poziomami linii większy niż rozpiętość klas, aby poziom zawsze decydował przed klasą.
const LINE_RANK_STEP = 10, TUNNEL_LINE_LIGHTEN = 0.55;
const TUNNEL_STEP_METERS = 1, TUNNEL_COVER_METERS = 0.6, BUILDING_CELL_METERS = 25, TUNNEL_COPING_METERS = 0.15, TUNNEL_MIN_WALL_METERS = 0.25;
const STRIPE_CLIP_STEP_METERS = 0.1, MIN_STRIPE_METERS = 0.4;
const CROSSING_LINE_TAPER_METERS = 1, CROSSING_LINE_MIN_PIXEL_SHARE = 0.55;
/**
 * Jawna kolejność rysowania, od spodu. Nawierzchnia nie zawiera linii ani znaków, linie tras leżą nad nią,
 * a oznakowanie nad liniami. Bryły przesłaniają warstwy nakładane testem głębi, gdy naprawdę są wyżej.
 */
export const LAYER_ORDER = Object.freeze({
  // Posadzka przy ścianie oporowej zastępuje teren w pasie przy licu: rysowana zaraz po terenie, przed nawierzchniami.
  wallFloor: 0, tunnelFloor: 5, casing: 10, sunk: 14, ground: 20, groundOther: 20, solid: 40, tunnel: 41, barrier: 42, stairs: 44, structure: 45, raisedCasing: 49, raised: 50, raisedOther: 50,
  // Oznakowanie jezdni na gruncie leży w kolejności zaraz po nawierzchniach na gruncie: nasyp lub pomost, który zakrywa jezdnię, zakrywa też jej linie.
  markGround: 30, mark: 60, point: 72, line: 100, stairLine: 106,
  // Linie boisk leżą na terenie (z odsunięciem głębi); przewody linii energetycznych to odcinki po bryłach.
  pitchMark: 31, wire: 46,
});
// Strzałki w układzie: wzdłuż kierunku jazdy, w prawo od niego (metry dla pasa o szerokości 3,25 m).
const ARROW_PATHS = {
  through: [[0, 0], [3.4, 0]], left: [[0, 0], [1.8, 0], [2.7, -1]], right: [[0, 0], [1.8, 0], [2.7, 1]],
  slight_left: [[0, 0], [1.9, 0], [3.4, -0.6]], slight_right: [[0, 0], [1.9, 0], [3.4, 0.6]],
  sharp_left: [[0, 0], [1.8, 0], [1.2, -1]], sharp_right: [[0, 0], [1.8, 0], [1.2, 1]],
  merge_to_left: [[0, 0], [1.2, 0], [3.2, -1.1]], merge_to_right: [[0, 0], [1.2, 0], [3.2, 1.1]],
  reverse: [[0, 0], [2.4, 0], [2.8, -0.45], [2.4, -0.9], [1.5, -0.9]],
};
// Podstawa ścian budynku biegnie po rysowanym terenie: krawędzie dzielone co WALL_BASE_STEP_METERS, dół o
// WALL_BASE_SINK_METERS pod gruntem (teren ma odsuniętą głębię, więc ściana poniżej gruntu byłaby widoczna jako cokół).
const WALL_BASE_STEP_METERS = 2, WALL_BASE_SINK_METERS = 0.03;
const STAIR_PIECE_METERS = 2, STAIR_SOFFIT = 0.18, STAIR_LINE_STEP = 0.02, MAX_FAN_SLOPE = 0.25;
const capSegments = (half) => Math.min(28, Math.max(10, Math.ceil(half * 7))); // Łuk ma pozostać gładki także na szerokiej jezdni.
const isRibbonWay = (state) => state.feature.geometry === "way" && state.interp.geometry === "line";
const widthOf = (state) => state.interp.dimensions.width?.value ?? state.interp.classDef.widthMeters ?? 2;

function polygonsOf(feature) {
  if (feature.geometry === "multipolygon") {
    return feature.polygons.map((rings) => rings.map((ring) => {
      const out = [];
      for (let i = 0; i < ring.length - 2; i += 2) out.push(new THREE.Vector2(ring[i], ring[i + 1]));
      return out;
    }));
  }
  const ring = [];
  for (let i = 0; i < feature.points.length - 3; i += 3) ring.push(new THREE.Vector2(feature.points[i], feature.points[i + 1]));
  return [[ring]];
}

function groundOf(feature) {
  if (feature.anchor) return feature.anchor[2];
  let low = Infinity;
  for (let i = 2; i < feature.points.length; i += 3) if (feature.points[i] !== null) low = Math.min(low, feature.points[i]);
  return Number.isFinite(low) ? low : null;
}

export class FeatureRenderer {
  constructor(model, shared) {
    this.model = model;
    this.group = new THREE.Group();
    this.chunks = new Map();
    // Siatki jeszcze niewysłane na GPU: silnik wysyła je w tle małymi porcjami (Engine._primeMeshes).
    this.unuploaded = [];
    this.pickIds = new Map();
    this.pickFeatures = [null];
    this.hiddenGroups = new Set();
    this.detail = 1;
    this.joints = null;
    this.materials = {
      // Nawierzchnie na gruncie nie zapisują głębi, ale wzniesienia i bryły je zasłaniają.
      casing: ribbonMaterial(shared, { depthWrite: false }),
      ground: marksVisibleRoad(surfaceRibbonMaterial(shared, { depthWrite: false })),
      // Ścieżka lub chodnik w poziomie gruntu leżący na jezdni to przejście: nie kasuje znacznika, więc zebra i linie zostają na wierzchu.
      groundOther: surfaceRibbonMaterial(shared, { depthWrite: false }),
      // Przebieg tunelu jest przygaszony na powierzchni terenu i leży pod nawierzchniami tras nad nim.
      sunk: surfaceRibbonMaterial(shared, { alpha: 0.45, depthTest: false, depthWrite: false }),
      // Góra podniesionej jezdni: obwódka i nawierzchnia leżą na tej samej wysokości.
      raisedCasing: ribbonMaterial(shared, { bias: 1 }),
      raised: marksVisibleRoad(surfaceRibbonMaterial(shared, { bias: -1 })),
      // Ścieżka na nasypie lub kładce nad jezdnią kasuje znacznik: linie jezdni pod nią nie są widoczne.
      raisedOther: clearsVisibleRoad(surfaceRibbonMaterial(shared, { bias: -1 })),
      // Oznakowanie i linie przebiegu są osobnymi warstwami nad materiałem.
      // Rysowane po pomostach z testem głębi: pomost zasłania je tylko wtedy, gdy naprawdę leży wyżej.
      // Cienkie oznakowanie leży nad linią, bo inaczej linia zakryłaby środkowy pas i strzałki.
      // Linie przebiegu są schematem: rysowane na wierzchu, bez testu głębi, więc nie przesłania ich żadna bryła ani teren.
      line: ribbonMaterial(shared, { depthTest: false, depthWrite: false }),
      mark: onVisibleRoad(ribbonMaterial(shared, { bias: -3, depthWrite: false })),
      markGround: onVisibleRoad(ribbonMaterial(shared, { bias: -3, depthWrite: false })),
      solid: solidMaterial(shared),
      // Tuba tunelu nie podlega wycięciu, które otwiera jej wnętrze w terenie i bryłach.
      // Posadzka zapisuje głębię przed nawierzchnią trasy, aby ściany i teren przesłaniały ją poprawnie.
      tunnel: solidMaterial(shared, { cut: false }),
      tunnelFloor: solidMaterial(shared, { cut: false }),
      // Płyta mostu jest nieprzezroczysta; odsunięta głębia daje pierwszeństwo pomostom leżącym na jej wysokości.
      structure: solidMaterial(shared, { depthPush: STRUCTURE_DEPTH_PUSH_METERS }),
      stairs: stairMaterial(shared),
      barrier: barrierMaterial(shared),
      // Linia trasy na schodach jest osobną warstwą nad materiałem stopni.
      stairLine: ribbonMaterial(shared, { depthTest: false, depthWrite: false }),
      point: pointMaterial(shared),
      pitchMark: solidMaterial(shared, { bias: -2 }),
      wire: model.profile.furniture ? wireMaterial(shared, model.profile.furniture.power.wireColour) : null,
    };
    this.order = LAYER_ORDER;
    // Drzewa i krzewy są instancjami (render/vegetation.js), budowanymi razem z kawałkiem obiektu źródłowego.
    this.vegetation = model.profile.vegetation ? new VegetationLayer(shared, model.profile) : null;
    // Praca roślinności (obiekt × kwadrat) czeka w kolejce i jest wykonywana porcjami w pętli silnika (buildVegetation).
    this.vegetationQueue = [];
    // Latarnie, maszty, słupy i przewody, linie i wyposażenie boisk (render/furniture.js).
    this.furniture = model.profile.furniture && model.profile.sports ? new Furniture(this) : null;
  }

  pickColor(id) {
    if (!this.pickIds.has(id)) { this.pickIds.set(id, this.pickFeatures.length); this.pickFeatures.push(id); }
    const n = this.pickIds.get(id);
    return [(n & 255) / 255, ((n >> 8) & 255) / 255, ((n >> 16) & 255) / 255];
  }
  featureFromPick(n) { return this.pickFeatures[n] ?? null; }

  _chunkKey(feature) {
    const p = feature.point ?? feature.anchor ?? feature.points;
    return `${Math.floor(p[0] / CHUNK)}:${Math.floor(p[1] / CHUNK)}`;
  }

  addAll() {
    this.joints = null; this.buildingCells = null; this.coverGrid = null; this.priorities = null; this.plates = null; this.plateStates = null; this.plateLines = null; this.clearance = null; this.furniture?.invalidate();
    // Zestaw obiektów mógł się zmienić (zwolnione kafle danych): kawałki są zapełniane od nowa, a puste tracą siatki przy przebudowie.
    for (const chunk of this.chunks.values()) chunk.ids.clear();
    for (const state of this.model.states.values()) {
      const key = this._chunkKey(state.feature);
      if (!this.chunks.has(key)) {
        const [x, y] = key.split(":").map(Number);
        this.chunks.set(key, { key, cx: (x + 0.5) * CHUNK, cy: (y + 0.5) * CHUNK, ids: new Set(), meshes: [] });
      }
      this.chunks.get(key).ids.add(state.feature.id);
      state.chunk = key;
      this.pickColor(state.feature.id);
    }
    this.chunkOf = new Map([...this.model.states.values()].map((s) => [s.feature.id, s.chunk]));
    if (!this.chunks.has(SUPPORT_CHUNK)) this.chunks.set(SUPPORT_CHUNK, { key: SUPPORT_CHUNK, cx: 0, cy: 0, ids: new Set(), meshes: [] });
    for (const chunk of this.chunks.values()) this.rebuild(chunk);
  }

  /** Zestaw obiektów zmienił się: indeksy pochodne (węzły, pokrycie, budynki, priorytety, płyty mostów) liczą się od nowa. */
  invalidateCaches() {
    this.joints = null; this.buildingCells = null; this.coverGrid = null; this.priorities = null; this.plates = null; this.plateStates = null; this.plateLines = null; this.clearance = null; this.furniture?.invalidate();
    this.cacheGeneration = this.model.generation;
  }

  _place(state) {
    const key = this._chunkKey(state.feature);
    if (!this.chunks.has(key)) {
      const [x, y] = key.split(":").map(Number);
      this.chunks.set(key, { key, cx: (x + 0.5) * CHUNK, cy: (y + 0.5) * CHUNK, ids: new Set(), meshes: [] });
    }
    this.chunks.get(key).ids.add(state.feature.id);
    state.chunk = key;
    this.chunkOf.set(state.feature.id, key);
    this.pickColor(state.feature.id);
    return key;
  }

  /**
   * Doczytane lub zwolnione kafle danych: przydział obiektów do kawałków i lista kawałków do przebudowy. Przebudowywane są
   * tylko kawałki z obiektami nowymi, usuniętymi, ze zmienionym odciskiem planu (changed) albo leżącymi w zmienionych
   * obszarach (regions: obrysy kafli z zapasem, gdzie zmieniło się otoczenie: węzły, pokrycie nawierzchni, budynki).
   * Pozostałe kawałki zostają bez zmian. Przebudowę wykonuje rebuildChunk (wywołujący może ją rozłożyć na klatki).
   */
  update(changed, removed, regions) {
    // Indeksy rysowania są ważne dla bieżącego pokolenia modelu (mogły zostać policzone wcześniej przez warmSteps).
    if (this.cacheGeneration !== this.model.generation) this.invalidateCaches();
    if (!this.chunkOf) {
      this.chunkOf = new Map();
      if (!this.chunks.has(SUPPORT_CHUNK)) this.chunks.set(SUPPORT_CHUNK, { key: SUPPORT_CHUNK, cx: 0, cy: 0, ids: new Set(), meshes: [] });
    }
    const keys = new Set([SUPPORT_CHUNK]), ids = new Set(changed);
    for (const id of removed) {
      const key = this.chunkOf.get(id);
      if (key === undefined) continue;
      this.chunks.get(key)?.ids.delete(id);
      this.chunkOf.delete(id);
      keys.add(key);
    }
    for (const state of this.model.states.values()) {
      const id = state.feature.id;
      if (this.chunkOf.get(id) === undefined) { keys.add(this._place(state)); ids.add(id); continue; }
      if (ids.has(id)) continue;
      const box = boundsOf(state.feature);
      if (regions.some((r) => box[0] <= r[2] && box[2] >= r[0] && box[1] <= r[3] && box[3] >= r[1])) ids.add(id);
    }
    for (const key of this._affected([...ids].filter((id) => this.model.states.has(id)))) keys.add(key);
    return keys;
  }

  /** Przebudowa jednego kawałka; pusty kawałek (same usunięte obiekty) traci siatki i znika. */
  rebuildChunk(key) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.rebuild(chunk);
    if (!chunk.ids.size && key !== SUPPORT_CHUNK) this.chunks.delete(key);
  }

  get deckThickness() { return this.model.profile.inferredSupports.deckThicknessMeters; }

  _jointMap() {
    if (this.joints) return this.joints;
    this.joints = new Map(); this.coverGrid = null; this.priorities = null;
    for (const state of this.model.states.values()) {
      if (!isRibbonWay(state)) continue;
      const refs = state.feature.nodeRefs;
      refs.forEach((ref, position) => {
        if (!this.joints.has(ref)) this.joints.set(ref, []);
        this.joints.get(ref).push({ state, position, atEnd: position === 0 || position === refs.length - 1, partner: null });
      });
    }
    for (const entries of this.joints.values()) this._pairEnds(entries);
    return this.joints;
  }

  /** W węźle łączy w pary końce tras biegnących najbardziej na wprost; pozostałe trasy dochodzą do nich z boku. */
  _pairEnds(entries) {
    // Schody są bryłą, więc dojście kończy się przy nich własnym zaokrągleniem, a nie przejściem wstęgi.
    const ends = entries.filter((e) => e.atEnd && !e.state.interp.classDef.stairs);
    if (ends.length < 2) return;
    const candidates = [];
    for (let i = 0; i < ends.length; i += 1) {
      for (let j = i + 1; j < ends.length; j += 1) {
        const a = ends[i], b = ends[j];
        const mine = this._inward(a.state, a.position), theirs = this._inward(b.state, b.position);
        let ax = mine.x - mine.ix, ay = mine.y - mine.iy, bx = theirs.ix - theirs.x, by = theirs.iy - theirs.y;
        const al = Math.hypot(ax, ay) || 1, bl = Math.hypot(bx, by) || 1;
        ax /= al; ay /= al; bx /= bl; by /= bl;
        const cos = ax * bx + ay * by;
        const widthA = widthOf(a.state), widthB = widthOf(b.state);
        // Ostrzejszy zakręt nie jest kontynuacją: ścięcie dałoby szpic, a łuk zachowuje szerokość trasy.
        if (cos < MIN_CONTINUATION_COS || Math.max(widthA, widthB) / Math.min(widthA, widthB) > MAX_WIDTH_RATIO) continue;
        const defA = a.state.interp.classDef, defB = b.state.interp.classDef;
        // W rozwidleniu droga nie przechodzi płynnie w ścieżkę innego rodzaju.
        if (entries.length > 2 && defA.group !== defB.group) continue;
        candidates.push({ a, b, score: cos + (a.state.interp.classId === b.state.interp.classId ? 1 : 0) + (defA.group === defB.group ? 0.3 : 0) });
      }
    }
    candidates.sort((p, q) => q.score - p.score);
    for (const { a, b } of candidates) {
      if (a.partner || b.partner) continue;
      a.partner = b; b.partner = a;
    }
  }

  /** Oś rysowanej jezdni; placement może ją przesunąć względem wayu, a dane OSM pozostają bez zmian. */
  axisOf(state) { return this.model.surfaces?.byId.get(state.feature.id)?.axis ?? state.feature.points; }

  _groupHidden(group) {
    const parent = this.model.profile.groups[group]?.parent;
    return this.hiddenGroups.has(group) || (parent !== undefined && this.hiddenGroups.has(parent));
  }

  /** Punkt przy końcu trasy, patrząc od węzła końcowego w głąb tej trasy. */
  _inward(state, position) {
    const points = this.axisOf(state);
    const last = points.length / 3 - 1;
    const end = position === 0 ? 0 : last, next = position === 0 ? 1 : last - 1;
    return { x: points[end * 3], y: points[end * 3 + 1], ix: points[next * 3], iy: points[next * 3 + 1] };
  }

  /** Rodzaj połączenia na końcu trasy, ustalony tylko ze wspólnego węzła i symetryczny dla obu tras. */
  _joinAt(state, atStart) {
    const refs = state.feature.nodeRefs;
    const position = atStart ? 0 : refs.length - 1;
    const entries = this._jointMap().get(refs[position]) ?? [];
    const own = entries.find((e) => e.state === state && e.position === position);
    // Gałąź rozwidlenia jest przesunięta obok osi pnia, więc styk z pniem biegnie poprzecznie do pnia, a nie w stronę jego osi.
    const fork = this.model.surfaces?.byId.get(state.feature.id)?.forks?.[atStart ? "start" : "end"];
    const trunk = fork && entries.find((e) => e.state.feature.id === fork.trunk && e.atEnd);
    if (trunk) {
      const mine = this._inward(state, position), theirs = this._inward(trunk.state, trunk.position);
      // Relacja connectivity może wskazać inną liczbę pasów pnia niż ma gałąź: gałąź zwęża się lub poszerza do nich przy węźle.
      const forkWidth = fork.width !== undefined && Math.abs(fork.width - widthOf(state)) > 0.01 ? fork.width : undefined;
      // Styk jest prostopadły do kierunku pnia z danych, tego samego, według którego gałąź została przesunięta w przekroju pnia.
      const [hx, hy] = fork.hx !== undefined ? [fork.hx, fork.hy] : [theirs.ix - theirs.x, theirs.iy - theirs.y];
      return { type: "continuation", neighbour: trunk.state, nx: mine.x + hx, ny: mine.y + hy, square: true, forkWidth };
    }
    // Pień rozwidlenia kończy się prostopadle do własnego kierunku, na całej szerokości gałęzi.
    const trunkPlan = this.model.surfaces?.byId.get(state.feature.id), key = atStart ? "start" : "end";
    const branch = trunkPlan?.forkTotal?.[key] && (own?.partner ?? entries.find((e) => e.state !== state && e.atEnd));
    if (branch) {
      const mine = this._inward(state, position), heading = trunkPlan.forkHeading?.[key] ?? [mine.ix - mine.x, mine.iy - mine.y];
      return { type: "continuation", neighbour: branch.state, nx: mine.x - heading[0], ny: mine.y - heading[1], square: true };
    }
    if (own?.partner) {
      const theirs = this._inward(own.partner.state, own.partner.position);
      return { type: "continuation", neighbour: own.partner.state, nx: theirs.ix, ny: theirs.iy };
    }
    return { type: entries.length > 1 ? "junction" : "end" };
  }

  /** Wysokość podłoża bariery: pomost dla barier na moście, w pozostałych miejscach rysowany teren. */
  _barrierGround(x, y, plan, fallback) { return this._barrierSupport(x, y, plan, fallback).z; }

  _barrierSupport(x, y, plan, fallback) {
    if (plan.onStructure) {
      let best = null;
      for (const g of this._coverIndex().get(`${Math.floor(x / COVER_CELL_METERS)}:${Math.floor(y / COVER_CELL_METERS)}`) ?? []) {
        if (!g.state.level?.lifted || g.state.level.units <= 0) continue;
        const dx = g.bx - g.ax, dy = g.by - g.ay, t = Math.max(0, Math.min(1, ((x - g.ax) * dx + (y - g.ay) * dy) / (dx * dx + dy * dy || 1))), d = Math.hypot(x - g.ax - dx * t, y - g.ay - dy * t) - g.half;
        if (d < BARRIER_DECK_REACH_METERS && (!best || d < best.d)) best = { d, z: g.za + (g.zb - g.za) * t, deck: g.state.feature.id };
      }
      if (best) return best;
      // Bariera w obrysie mostu (ekran, balustrada przy krawędzi płyty) stoi na płycie, jak trasa na pomoście.
      const layer = plan.layer > 0 ? plan.layer : undefined, plates = this._platesAt(x, y, layer);
      if (plates.length) {
        const plate = plates.reduce((a, c) => (c.heightAt(x, y) > a.heightAt(x, y) ? c : a));
        return { z: plate.heightAt(x, y), deck: `plate:${plate.id}` };
      }
    }
    return { z: this.groundAt?.(x, y) ?? fallback, deck: null };
  }

  /** Przebieg bariery: podstawa jest gładka, ale trzyma się podłoża; styk pomostu z terenem dzieli barierę na osobne odcinki. */
  barrierProfile(state, plan) {
    const line = { points: state.feature.points, along: plan.along }, vertices = new Set(plan.along), pieces = [];
    const tolerance = Math.min(BARRIER_GROUND_TOLERANCE, plan.height * BARRIER_TOLERANCE_RATIO);
    const rowAt = (s) => {
      const p = stairPoint(line, s), a = stairPoint(line, Math.max(0, s - 0.05)), b = stairPoint(line, Math.min(plan.length, s + 0.05));
      let tx = a.tx + b.tx, ty = a.ty + b.ty; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      const support = this._barrierSupport(p.x, p.y, plan, p.ground);
      const row = { s, x: p.x, y: p.y, nx: -ty, ny: tx, ground: support.z, deck: support.deck, vertex: vertices.has(s) };
      if (plan.retaining && !support.deck && this.groundAt) {
        // Ściana oporowa: podstawa na terenie po niższej stronie (konwencja OSM: po prawej, chyba że NMT wyraźnie pokazuje odwrotnie),
        // a lico do terenu po wyższej. Dół ściany z cięciem terenu jest czytany z NMT bez dopasowania, bo to on wyznacza
        // obniżenie terenu przy ścianie (odwrotna zależność dawałaby wynik zależny od kolejności przeliczeń). Góra i ściany
        // bez cięcia korzystają z rysowanego terenu (z dopasowaniem do tras), na którym faktycznie stoją.
        const k = -this.retainingSide(plan).lower, low = this.retainingCuts(plan) ? this.terrainAt ?? this.groundAt : this.groundAt;
        const lower = Math.min(...RETAINING_PROBE_METERS.map((d) => low(p.x + ty * d * k, p.y - tx * d * k) ?? NaN));
        const upper = Math.max(...RETAINING_PROBE_METERS.map((d) => this.groundAt(p.x - ty * d * k, p.y + tx * d * k) ?? NaN));
        const lineLow = low(p.x, p.y) ?? support.z, lineHigh = this.groundAt(p.x, p.y) ?? support.z;
        if (Number.isFinite(lower) && Number.isFinite(upper)) { row.ground = Math.min(lower, lineLow, this._routesBelow(p.x, p.y, ty * k, -tx * k, lower - RETAINING_ROUTE_DROP_METERS)); row.upper = Math.max(upper, lineHigh); }
        // Pod mostem (w obrysie albo przy jego krawędzi) ściana jest przyczółkiem: kończy się na spodzie płyty, a nie na jezdni.
        const plates = this._platesAt(p.x, p.y, undefined);
        if (plates.length && row.upper !== undefined) { row.upper = Math.min(...plates.map((plate) => plate.heightAt(p.x, p.y) - this.deckThickness)); row.underPlate = true; }
      }
      return row;
    };
    for (const [from, to] of plan.spans) {
      const stations = new Set([from, to]);
      for (const s of plan.along) if (s > from && s < to) stations.add(s);
      for (let s = Math.ceil(from / BARRIER_STEP_METERS) * BARRIER_STEP_METERS; s < to; s += BARRIER_STEP_METERS) stations.add(s);
      const rows = [...stations].sort((a, b) => a - b).filter((s, i, all) => !i || s - all[i - 1] > 0.05).map(rowAt).filter((row) => row.ground !== null && Number.isFinite(row.ground));
      // Ściana oporowa obudowuje wykop (przejście, rampę tunelu), a nie przechodzi nad nim jak przęsło.
      if (plan.over?.length && !plan.retaining) this._bridgeDips(rows, plan.over);
      if (plan.retaining) {
        // Dół ściany oporowej: najniższy odczyt terenu po niższej stronie w oknie ±RETAINING_LOW_WINDOW_METERS wzdłuż ściany.
        // Odczyt pojedynczego punktu (np. pod mostem, gdzie NMT jest zaszumiony) skacze o kilka metrów i daje poszarpaną krawędź.
        const low = rows.map((row) => Math.min(...rows.filter((other) => Math.abs(other.s - row.s) <= RETAINING_LOW_WINDOW_METERS && !other.deck).map((other) => other.ground), row.ground));
        rows.forEach((row, i) => { if (!row.deck) row.ground = low[i]; });
      }
      let piece = [];
      for (const row of rows) {
        const prev = piece[piece.length - 1];
        if (prev && prev.deck !== row.deck && Math.abs(prev.ground - row.ground) > BARRIER_SUPPORT_JUMP) {
          // Dokładne miejsce zmiany podłoża: bariera nie może tworzyć rampy między pomostem a terenem.
          let low = prev, high = row;
          for (let k = 0; k < 8; k += 1) {
            const mid = rowAt((low.s + high.s) / 2);
            if (!Number.isFinite(mid.ground)) break;
            if (mid.deck === low.deck) low = mid; else high = mid;
          }
          // Punkt z bisekcji poza pomostem bierze podłoże przeskoczone tak jak sąsiedni wiersz po tej samej stronie.
          if (plan.over?.length && !plan.retaining) for (const r of [low, high]) { const side = r.deck === prev.deck ? prev : row; if (!r.deck && !side.deck) r.ground = Math.max(r.ground, side.ground); }
          if (Math.abs(low.ground - high.ground) > BARRIER_SUPPORT_JUMP) {
            if (low !== prev) piece.push(low);
            pieces.push(piece); piece = high !== row ? [high] : [];
          }
        }
        piece.push(row);
      }
      pieces.push(piece);
    }
    const settled = pieces.filter((rows) => rows.length > 1).map((rows) => this._settleBarrier(rows, tolerance));
    if (plan.retaining) for (const rows of settled) this._retainingTop(rows, plan);
    return settled;
  }

  /**
   * Najniższa nawierzchnia trasy na gruncie (bez mostów i tuneli) w pasie posadzki po niższej stronie ściany, w kierunku
   * (dx, dy) od osi. Dół ściany nie leży wyżej niż trasa biegnąca przy niej, więc posadzka nie przykrywa chodnika ani jezdni.
   * Trasy niżej niż `floor` (teren po niższej stronie minus RETAINING_ROUTE_DROP_METERS) są pomijane: tak głęboko leżą tylko
   * trasy związane z tunelem lub jego wlotem, które mają własne konstrukcje.
   */
  _routesBelow(x, y, dx, dy, floor) {
    let lowest = Infinity;
    for (let d = 0.5; d <= WALL_BAND_METERS; d += 0.5) {
      const px = x + dx * d, py = y + dy * d;
      for (const g of this._coverIndex().get(`${Math.floor(px / COVER_CELL_METERS)}:${Math.floor(py / COVER_CELL_METERS)}`) ?? []) {
        if (g.state.level?.lifted) continue;
        const sx = g.bx - g.ax, sy = g.by - g.ay, t = Math.max(0, Math.min(1, ((px - g.ax) * sx + (py - g.ay) * sy) / (sx * sx + sy * sy || 1)));
        const z = g.za + (g.zb - g.za) * t;
        if (z >= floor && Math.hypot(px - g.ax - sx * t, py - g.ay - sy * t) <= g.half) lowest = Math.min(lowest, z);
      }
    }
    return lowest;
  }

  /**
   * Strona niższa ściany oporowej (lower: −1 prawa, +1 lewa względem kierunku linii) i wyraźność uskoku w NMT (step, m).
   * Konwencja OSM: niższa strona po prawej. Gdy NMT wyraźnie (średnio o RETAINING_CLEAR_STEP_METERS) pokazuje odwrotnie,
   * decyduje teren, a ściana trafia do `reversed` (prawdopodobnie odwrócony kierunek linii w OSM).
   */
  retainingSide(plan) {
    if (RETAINING_SIDES.has(plan)) return RETAINING_SIDES.get(plan);
    const at = this.terrainAt ?? this.groundAt, p = this.model.states.get(plan.id).feature.points;
    let sum = 0, count = 0;
    for (let i = 3; at && i < p.length; i += 3) {
      const ax = p[i - 3], ay = p[i - 2], dx = p[i] - ax, dy = p[i + 1] - ay, l = Math.hypot(dx, dy);
      if (l < 0.5) continue;
      for (let f = 0.25; f < 1; f += 0.25) {
        const x = ax + dx * f, y = ay + dy * f, d = RETAINING_SIDE_PROBE_METERS;
        const left = at(x - (dy / l) * d, y + (dx / l) * d), right = at(x + (dy / l) * d, y - (dx / l) * d);
        if (Number.isFinite(left) && Number.isFinite(right)) { sum += left - right; count += 1; }
      }
    }
    const mean = count ? sum / count : 0, side = { lower: mean <= -RETAINING_CLEAR_STEP_METERS ? 1 : -1, step: Math.abs(mean), reversed: mean <= -RETAINING_CLEAR_STEP_METERS };
    if (at) RETAINING_SIDES.set(plan, side);
    return side;
  }

  /**
   * Góra lica ściany oporowej: teren po wyższej stronie, wygładzony wzdłuż ściany. Gdzie teren nie pokazuje uskoku
   * (mniej niż RETAINING_MIN_STEP_METERS), ściana ma wysokość z tagu height albo z profilu, jak inne bariery.
   */
  _retainingTop(rows, plan) {
    const upper = rows.map((row) => row.upper ?? row.base + plan.height);
    rows.forEach((row, i) => {
      let sum = 0, weight = 0;
      for (let k = 0; k < rows.length; k += 1) { if (Math.abs(rows[k].s - row.s) <= RETAINING_SMOOTH_METERS) { sum += upper[k]; weight += 1; } }
      const top = sum / weight;
      row.top = top - row.base >= RETAINING_MIN_STEP_METERS ? top : row.base + plan.height;
    });
  }

  /**
   * Bariera nad trasą przechodzącą pod nią (przejście pod drogą, tunel): jak przęsło mostu nie schodzi w wycięcie terenu
   * nad tą trasą. Przęsło biegnie od najwyższego punktu podłoża do BARRIER_SHOULDER_METERS przed miejscem przecięcia do
   * najwyższego punktu do tej samej odległości za nim; podłoże między nimi leży co najmniej na tej prostej. Pomost i płyta
   * mostu są nieruchomymi podporami, a reszta bariery trzyma się podłoża jak wcześniej.
   */
  _bridgeDips(rows, over) {
    const n = rows.length, raw = rows.map((row) => row.ground);
    for (const { s } of over) {
      if (s < rows[0].s - 1 || s > rows[n - 1].s + 1) continue;
      let a = -1, b = -1;
      for (let i = 0; i < n; i += 1) {
        const d = rows[i].s - s;
        if (d <= 0 && d >= -BARRIER_SHOULDER_METERS && (a < 0 || raw[i] > raw[a])) a = i;
        if (d >= 0 && d <= BARRIER_SHOULDER_METERS && (b < 0 || raw[i] > raw[b])) b = i;
      }
      if (a < 0 || b < 0 || b - a < 2) continue;
      const run = rows[b].s - rows[a].s || 1;
      for (let i = a + 1; i < b; i += 1) {
        if (rows[i].deck) continue;
        rows[i].ground = Math.max(rows[i].ground, raw[a] + ((raw[b] - raw[a]) * (rows[i].s - rows[a].s)) / run);
      }
    }
  }

  /** Wygładza podstawę na równej siatce co 1 m, nie pozwalając jej odejść od podłoża dalej niż o tolerancję. */
  _settleBarrier(rows, tolerance) {
    const first = rows[0].s, length = rows[rows.length - 1].s - first, cells = Math.max(1, Math.ceil(length)), ground = [];
    const clamp = (value, floor) => Math.max(floor - tolerance, Math.min(floor + tolerance, value));
    for (let k = 0, r = 1; k <= cells; k += 1) {
      const s = first + (length * k) / cells;
      while (r < rows.length - 1 && rows[r].s < s) r += 1;
      const a = rows[r - 1], c = rows[r], t = (s - a.s) / (c.s - a.s || 1);
      ground.push(a.ground + (c.ground - a.ground) * Math.max(0, Math.min(1, t)));
    }
    let grid = ground;
    for (let pass = 0; pass < BARRIER_SMOOTH_PASSES; pass += 1) {
      grid = grid.map((_, i) => {
        let sum = 0, weight = 0;
        for (let k = Math.max(0, i - BARRIER_SMOOTH_METERS); k <= Math.min(cells, i + BARRIER_SMOOTH_METERS); k += 1) { sum += grid[k]; weight += 1; }
        return clamp(sum / weight, ground[i]);
      });
    }
    rows.forEach((row, i) => {
      const at = ((row.s - first) / (length || 1)) * cells, k = Math.min(cells - 1, Math.floor(at)), f = at - k;
      row.base = clamp(grid[k] + (grid[k + 1] - grid[k]) * f, row.ground);
      // W załamaniu terenu dół schodzi głębiej, żeby między punktami siatki nie powstała szczelina.
      const before = rows[i - 1]?.ground ?? row.ground, after = rows[i + 1]?.ground ?? row.ground, bend = Math.min(BARRIER_MAX_BEND_METERS, Math.abs(before - 2 * row.ground + after) / 4);
      row.bottom = Math.min(row.ground, row.base) - BARRIER_SINK_METERS - bend;
    });
    // Odcinki proste upraszczamy, aby gęsta siatka kosztowała geometrię tylko tam, gdzie teren się zmienia.
    const kept = [rows[0]];
    let anchor = 0;
    for (let i = 1; i < rows.length - 1; i += 1) {
      const a = rows[anchor], c = rows[i + 1], run = c.s - a.s;
      const fits = !rows[i].vertex && run <= BARRIER_MAX_RUN_METERS && rows.slice(anchor + 1, i + 1).every((row) => {
        const t = (row.s - a.s) / run;
        return Math.abs(a.base + (c.base - a.base) * t - row.base) <= BARRIER_SIMPLIFY_METERS && Math.abs(a.bottom + (c.bottom - a.bottom) * t - row.bottom) <= BARRIER_SIMPLIFY_METERS;
      });
      if (!fits) { kept.push(rows[i]); anchor = i; }
    }
    kept.push(rows[rows.length - 1]);
    return kept;
  }

  _barrierStyle(plan, pick, span) {
    return { color: rgb(plan.color), accent: rgb(plan.accent ?? plan.color), pattern: Math.max(0, BARRIER_PATTERNS.indexOf(plan.pattern)), pick, span };
  }

  _barrierQuad(b, corners, normal, uvs, aos, style) {
    const start = b.count;
    corners.forEach((p, i) => {
      b.push("position", ...p); b.push("normal", ...normal); b.push("aColor", ...style.color); b.push("aAccent", ...style.accent); b.push("aPick", ...style.pick);
      b.push("aUv", ...uvs[i]); b.push("aPattern", style.pattern); b.push("aSpan", style.span); b.push("aAo", aos[i]); b.push("aRange", b.range);
      b.count += 1;
    });
    b.index.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }

  /** Ściany oporowe z wyraźnym uskokiem w NMT: tylko przy nich teren jest obniżany, cięty i zastępowany posadzką. */
  retainingCuts(plan) {
    return plan.retaining && this.retainingSide(plan).step >= RETAINING_CLEAR_STEP_METERS;
  }

  /** Odcinki pasa posadzki ścian oporowych dla cięcia terenu (te same wiersze profilu co posadzka i lico). */
  retainingCutSegments() {
    const out = [];
    let wall = 0;
    for (const plan of this.model.barriers?.byId.values() ?? []) {
      if (!this.retainingCuts(plan)) continue;
      wall += 1;
      const lower = this.retainingSide(plan).lower;
      for (const rows of this.barrierProfile(this.model.states.get(plan.id), plan)) {
        for (let i = 1; i < rows.length; i += 1) {
          const a = rows[i - 1], c = rows[i];
          if (Math.hypot(c.x - a.x, c.y - a.y) < 0.01) continue;
          out.push({ ax: a.x, ay: a.y, bx: c.x, by: c.y, wall, lower, band: WALL_BAND_METERS });
        }
        wall += 1;
      }
    }
    return out;
  }

  /** Posadzka po niższej stronie ściany oporowej: od lica do szerokości pasa, na wysokości dołu ściany, materiałem terenu. */
  _emitRetainingFloor(state, plan, bucket) {
    if (!this.retainingCuts(plan) || !this.materials.wallFloor) return;
    const b = bucket("wallFloor", { group: "wallFloor", tier: 0 }), lower = this.retainingSide(plan).lower, half = plan.thickness / 2;
    for (const rows of this.barrierProfile(state, plan)) {
      for (let i = 1; i < rows.length; i += 1) {
        const a = rows[i - 1], c = rows[i], at = (r, o) => [r.x + r.nx * o * lower, r.y + r.ny * o * lower, r.base];
        let corners = [at(a, half), at(c, half), at(c, WALL_BAND_METERS), at(a, WALL_BAND_METERS)];
        const ux = corners[1][0] - corners[0][0], uy = corners[1][1] - corners[0][1], vx = corners[3][0] - corners[0][0], vy = corners[3][1] - corners[0][1];
        if (ux * vy - uy * vx < 0) corners = [corners[0], corners[3], corners[2], corners[1]];
        const start = b.count;
        for (const p of corners) { b.push("position", ...p); b.push("normal", 0, 0, 1); b.push("aFlag", 0); b.push("aCell", -1); b.count += 1; }
        b.index.push(start, start + 1, start + 2, start, start + 2, start + 3);
      }
    }
  }

  _emitBarrierWay(state, plan, bucket, pick) {
    this._emitRetainingFloor(state, plan, bucket);
    const b = bucket("barrier", state.interp.classDef), half = plan.thickness / 2, style = this._barrierStyle(plan, pick, plan.height);
    for (const rows of this.barrierProfile(state, plan)) {
      rows.forEach((row, i) => {
        const side = (r, sign, z) => [r.x + r.nx * half * sign, r.y + r.ny * half * sign, z];
        if (i > 0) {
          const a = rows[i - 1], c = row;
          const topA = a.top ?? a.base + plan.height, topC = c.top ?? c.base + plan.height;
          for (const sign of [-1, 1]) {
            this._barrierQuad(b, [side(a, sign, a.bottom), side(c, sign, c.bottom), side(c, sign, topC), side(a, sign, topA)], [c.nx * sign, c.ny * sign, 0], [[a.s, a.bottom - a.base], [c.s, c.bottom - c.base], [c.s, topC - c.base], [a.s, topA - a.base]], [0.55, 0.55, 1, 1], style);
          }
          if (plan.solidTop) this._barrierQuad(b, [side(a, -1, topA), side(a, 1, topA), side(c, 1, topC), side(c, -1, topC)], [0, 0, 1], [[a.s, 0], [a.s, plan.thickness], [c.s, plan.thickness], [c.s, 0]], [1, 1, 1, 1], { ...style, pattern: 0 });
        }
      });
      if (plan.solidTop) {
        for (const [r, sign] of [[rows[0], -1], [rows[rows.length - 1], 1]]) {
          const top = r.top ?? r.base + plan.height, tx = r.ny * sign, ty = -r.nx * sign, at = (side, z) => [r.x + r.nx * half * side, r.y + r.ny * half * side, z];
          this._barrierQuad(b, [at(-1, r.bottom), at(1, r.bottom), at(1, top), at(-1, top)], [tx, ty, 0], [[0, 0], [plan.thickness, 0], [plan.thickness, plan.height], [0, plan.height]], [0.55, 0.55, 1, 1], { ...style, pattern: 0 });
        }
      }
    }
  }

  /** Prostopadłościan o osi (ux, uy): słupki, bloki, szlabany i skrzydła bram. */
  _barrierBox(b, cx, cy, ux, uy, halfLength, halfDepth, z0, z1, style) {
    const nx = -uy, ny = ux, corner = (a, d, z) => [cx + ux * halfLength * a + nx * halfDepth * d, cy + uy * halfLength * a + ny * halfDepth * d, z], length = halfLength * 2, height = z1 - z0;
    for (const d of [-1, 1]) this._barrierQuad(b, [corner(-1, d, z0), corner(1, d, z0), corner(1, d, z1), corner(-1, d, z1)], [nx * d, ny * d, 0], [[0, 0], [length, 0], [length, height], [0, height]], [0.6, 0.6, 1, 1], style);
    for (const a of [-1, 1]) this._barrierQuad(b, [corner(a, -1, z0), corner(a, 1, z0), corner(a, 1, z1), corner(a, -1, z1)], [ux * a, uy * a, 0], [[0, 0], [halfDepth * 2, 0], [halfDepth * 2, height], [0, height]], [0.6, 0.6, 1, 1], { ...style, pattern: 0 });
    this._barrierQuad(b, [corner(-1, -1, z1), corner(1, -1, z1), corner(1, 1, z1), corner(-1, 1, z1)], [0, 0, 1], [[0, 0], [length, 0], [length, 1], [0, 1]], [1, 1, 1, 1], style);
  }

  _emitBarrierNode(state, plan, bucket, pick) {
    const b = bucket("barrier", state.interp.classDef), z0 = plan.baseZ ?? this._barrierGround(plan.x, plan.y, plan, state.feature.point[2]), z1 = z0 + plan.height, solid = this._barrierStyle({ ...plan, pattern: "solid" }, pick, plan.height);
    const [ux, uy] = plan.direction ?? [1, 0], half = plan.width / 2, post = BARRIER_POST_METERS / 2;
    if (plan.shape === "opening") return;
    if (plan.shape === "post" || !plan.direction) { const r = plan.shape === "post" ? Math.max(plan.thickness / 2, 0.05) : post; this._barrierBox(b, plan.x, plan.y, ux, uy, r, r, z0 - BARRIER_SINK_METERS, z1, solid); return; }
    if (plan.shape === "block") { this._barrierBox(b, plan.x, plan.y, ux, uy, plan.thickness / 2, plan.thickness / 2, z0 - BARRIER_SINK_METERS, z1, solid); return; }
    if (plan.shape === "kerb") { this._barrierBox(b, plan.x, plan.y, ux, uy, half, plan.thickness / 2, z0 - BARRIER_SINK_METERS, z1, solid); return; }
    if (plan.shape === "boom") {
      // Szlaban: słupek z ramieniem przez cały otwór; dwa ramiona (lift_gate:type=double) spotykają się w środku.
      const postHeight = plan.height + 0.15, sides = plan.leaves === 2 ? [-1, 1] : [-1], reach = plan.leaves === 2 ? half : plan.width;
      for (const side of sides) {
        const px = plan.x + ux * half * side, py = plan.y + uy * half * side;
        this._barrierBox(b, px, py, ux, uy, 0.14, 0.14, z0 - BARRIER_SINK_METERS, z0 + postHeight, { ...solid, color: rgb("#8f969c"), accent: rgb("#737a80") });
        this._barrierBox(b, px - ux * side * reach / 2, py - uy * side * reach / 2, ux, uy, reach / 2, plan.thickness / 2, z1 - plan.thickness / 2, z1 + plan.thickness / 2, this._barrierStyle(plan, pick, plan.thickness));
      }
      return;
    }
    for (const side of [-1, 1]) this._barrierBox(b, plan.x + ux * half * side, plan.y + uy * half * side, ux, uy, post, post, z0 - BARRIER_SINK_METERS, z1 + 0.05, solid);
    const leaf = this._barrierStyle(plan, pick, plan.height - 0.05);
    if (plan.motion === "sliding") {
      // Brama przesuwna: skrzydło zamyka otwór i wystaje za słupek (ogon przeciwwagi), pod nim belka jezdna, na końcu ogona słupek.
      const tail = plan.width * 0.35, cx = plan.x + ux * tail / 2, cy = plan.y + uy * tail / 2, span = half + tail / 2;
      this._barrierBox(b, cx, cy, ux, uy, span, plan.thickness / 2, z0 + 0.14, z1, leaf);
      this._barrierBox(b, cx, cy, ux, uy, span, 0.06, z0 + 0.04, z0 + 0.14, solid);
      this._barrierBox(b, plan.x + ux * (half + tail), plan.y + uy * (half + tail), ux, uy, post, post, z0 - BARRIER_SINK_METERS, z0 + 0.5, solid);
      return;
    }
    if (plan.leaves === 2) {
      // Brama dwuskrzydłowa: dwa skrzydła ze szczeliną w środku.
      const halfLeaf = Math.max(0.05, half / 2 - post - 0.02);
      for (const side of [-1, 1]) this._barrierBox(b, plan.x + ux * side * (half / 2), plan.y + uy * side * (half / 2), ux, uy, halfLeaf, plan.thickness / 2, z0 + 0.05, z1, leaf);
      return;
    }
    this._barrierBox(b, plan.x, plan.y, ux, uy, Math.max(0.05, half - post), plan.thickness / 2, z0 + 0.05, z1, leaf);
  }

  _isElevated(state) {
    const { level } = state, def = state.interp.classDef;
    if (def.stairs || !level) return false;
    if (level.lifted) return level.units > 0;
    if ((level.maxOffset ?? 0) <= EMBANKMENT_OFFSET) return false;
    // Jezdnia: nasypem jest już pojedyncze wyniesienie (rampa do przyczółka). Ścieżka, chodnik, droga rowerowa: dopiero odcinek
    // ponad terenem o długości co najmniej 15 m albo połowa trasy; lokalne odchylenie nie podnosi całej trasy ponad przejścia i chodniki.
    if (def.carriageway || level.raisedMeters === undefined) return true;
    const length = this.model.surfaces?.byId.get(state.feature.id)?.length ?? 0;
    return level.raisedMeters >= PATH_EMBANKMENT_METERS || level.raisedMeters >= length * 0.5;
  }

  /**
   * Zakończenie nawierzchni. Na gruncie boczna trasa dochodzi do węzła i leży pod trasą główną, więc styk tworzy
   * krawędź trasy głównej. Pomost ma głębię, dlatego tam koniec jest przycinany do krawędzi.
   */
  _fillEnd(state, atStart) {
    const refs = state.feature.nodeRefs, position = atStart ? 0 : refs.length - 1, base = this._joinAt(state, atStart), def = state.interp.classDef;
    if (base.type === "continuation" || !def.surfaced) return { join: base, over: [] };
    const entries = this._jointMap().get(refs[position]) ?? [], own = entries.find((e) => e.state === state && e.position === position);
    const others = entries.filter((e) => e !== own && e.state.interp.classDef.surfaced), stairs = others.filter((e) => e.state.interp.classDef.stairs), routes = others.filter((e) => !e.state.interp.classDef.stairs);
    const half = widthOf(state) / 2, { x, y, ix, iy } = this._inward(state, position), length = Math.hypot(ix - x, iy - y) || 1, wx = (ix - x) / length, wy = (iy - y) / length;
    const nodeZ = state.level?.z[atStart ? 0 : state.level.z.length - 1], raised = this._isElevated(state), over = [];
    const coversFrom = (start) => {
      let best = start;
      // Chodnik lub ścieżka nie przykrywa trasy biegnącej tuż obok; jezdnia zawsze dochodzi do swojego węzła.
      for (let step = 0; !def.carriageway && !raised && step < 4; step += 1) {
        const next = this._coverAt(x + wx * (best.cut + 0.05), y + wy * (best.cut + 0.05), nodeZ, state, wx, wy, x, y);
        if (!next || next.cut <= best.cut || next.cut > start.cut + COVER_MAX_EXTRA_METERS) break;
        over.push(next.state); best = next;
      }
      return best;
    };
    const finish = (edge) => {
      const best = coversFrom(edge);
      // Tylko pomost dochodzący do nawierzchni na gruncie jest przycinany, bo przykryłby ją swoją bryłą.
      return raised && over.some((other) => !this._isElevated(other)) ? { join: { type: "flush", tx: best.tx, ty: best.ty }, cut: best.cut, over } : { join: { type: "flat" }, over };
    };
    if (!others.length) {
      // Koniec bez wspólnego węzła, leżący na innej nawierzchni, nie jest rysowany na niej.
      const under = nodeZ === undefined || def.carriageway ? null : this._coverAt(x, y, nodeZ, state, wx, wy, x, y);
      if (under?.cut > 0) { over.push(under.state); return finish(under); }
      return { join: def.carriageway ? { type: "end" } : { type: "flat" }, over };
    }
    if (!routes.length) return { join: { type: "flat" }, extend: Math.max(half, ...stairs.map((e) => widthOf(e.state) / 2)), over };
    const continues = (e) => !e.atEnd || e.partner;
    const rank = (e) => (e.state.interp.classDef.carriageway ? 1000 : 0) + (continues(e) ? 100 : 0) + widthOf(e.state);
    let best = null, covered = false;
    for (const e of routes) {
      // Krawędź daje tylko trasa biegnąca dalej przez węzeł; kończąca się tutaj jej nie tworzy.
      if (!continues(e) || rank(e) <= rank(own)) continue;
      covered = true; over.push(e.state);
      let tx, ty, edge = widthOf(e.state) / 2;
      if (e.partner) {
        const a = this._inward(e.state, e.position), c = this._inward(e.partner.state, e.partner.position);
        const al = Math.hypot(a.ix - a.x, a.iy - a.y) || 1, cl = Math.hypot(c.ix - c.x, c.iy - c.y) || 1;
        tx = (c.ix - c.x) / cl - (a.ix - a.x) / al; ty = (c.iy - c.y) / cl - (a.iy - a.y) / al;
        edge = (edge + widthOf(e.partner.state) / 2) / 2;
      } else {
        const points = this.axisOf(e.state), k = e.state.feature.nodeIndex[e.position], n = points.length / 3, p = Math.max(0, k - 1), q = Math.min(n - 1, k + 1);
        tx = points[q * 3] - points[p * 3]; ty = points[q * 3 + 1] - points[p * 3 + 1];
      }
      const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      const sine = Math.abs(tx * wy - ty * wx);
      if (sine < MIN_FLUSH_SINE) continue;
      const cut = edge / sine;
      if (!best || cut > best.cut) best = { cut, tx, ty };
    }
    if (best) return finish(best);
    if (covered && (!raised || over.every((other) => this._isElevated(other)))) return { join: { type: "flat" }, over };
    return { join: { type: "junction" }, over: [] };
  }

  /** Kolejność nawierzchni na gruncie: trasa dochodząca leży pod trasą, do której dochodzi. */
  _drawPriority() {
    this._jointMap();
    if (this.priorities) return this.priorities;
    const priorities = new Map(), links = [];
    this.priorities = priorities;
    for (const state of this.model.states.values()) {
      if (!isRibbonWay(state) || !state.interp.classDef.surfaced || state.interp.classDef.stairs) continue;
      for (const atStart of [true, false]) for (const other of this._fillEnd(state, atStart).over) links.push([state.feature.id, other.feature.id]);
    }
    for (let pass = 0; pass < MAX_DRAW_LAYERS; pass += 1) {
      for (const [lower, upper] of links) {
        const wanted = Math.max(-MAX_DRAW_LAYERS, (priorities.get(upper) ?? 0) - 1);
        if (wanted < (priorities.get(lower) ?? 0)) priorities.set(lower, wanted);
      }
    }
    return priorities;
  }

  _coverIndex() {
    if (this.coverGrid) return this.coverGrid;
    this.coverGrid = new Map();
    for (const state of this.model.states.values()) {
      const def = state.interp.classDef;
      if (!isRibbonWay(state) || !def.surfaced || def.stairs || !state.level) continue;
      const points = this.axisOf(state), { z } = state.level, half = widthOf(state) / 2;
      for (let i = 3; i < points.length; i += 3) {
        const k = i / 3, segment = { state, ax: points[i - 3], ay: points[i - 2], bx: points[i], by: points[i + 1], za: z[k - 1], zb: z[k], half };
        const reach = half + COVER_GAP_METERS, x0 = Math.floor((Math.min(segment.ax, segment.bx) - reach) / COVER_CELL_METERS), x1 = Math.floor((Math.max(segment.ax, segment.bx) + reach) / COVER_CELL_METERS);
        const y0 = Math.floor((Math.min(segment.ay, segment.by) - reach) / COVER_CELL_METERS), y1 = Math.floor((Math.max(segment.ay, segment.by) + reach) / COVER_CELL_METERS);
        for (let cx = x0; cx <= x1; cx += 1) for (let cy = y0; cy <= y1; cy += 1) { const key = `${cx}:${cy}`; if (!this.coverGrid.has(key)) this.coverGrid.set(key, []); this.coverGrid.get(key).push(segment); }
      }
    }
    return this.coverGrid;
  }

  _onSurface(px, py, z, self) {
    return (this._coverIndex().get(`${Math.floor(px / COVER_CELL_METERS)}:${Math.floor(py / COVER_CELL_METERS)}`) ?? []).some((g) => {
      if (g.state === self) return false;
      const dx = g.bx - g.ax, dy = g.by - g.ay, t = Math.max(0, Math.min(1, ((px - g.ax) * dx + (py - g.ay) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(px - g.ax - dx * t, py - g.ay - dy * t) <= g.half && Math.abs(z - (g.za + (g.zb - g.za) * t)) <= COVER_LEVEL_METERS;
    });
  }

  /** Inna nawierzchnia tego samego poziomu w punkcie (px, py) i odległość od węzła do jej dalszej krawędzi. */
  _coverAt(px, py, z, self, wx, wy, nodeX, nodeY) {
    let found = null;
    for (const g of this._coverIndex().get(`${Math.floor(px / COVER_CELL_METERS)}:${Math.floor(py / COVER_CELL_METERS)}`) ?? []) {
      if (g.state === self) continue;
      const dx = g.bx - g.ax, dy = g.by - g.ay, l = Math.hypot(dx, dy) || 1, t = Math.max(0, Math.min(1, ((px - g.ax) * dx + (py - g.ay) * dy) / (l * l)));
      if (Math.hypot(px - g.ax - dx * t, py - g.ay - dy * t) > g.half + COVER_GAP_METERS || Math.abs(z - (g.za + (g.zb - g.za) * t)) > COVER_LEVEL_METERS) continue;
      const tx = dx / l, ty = dy / l;
      let nx = -ty, ny = tx, along = wx * nx + wy * ny;
      if (Math.abs(along) < MIN_FLUSH_SINE) continue;
      if (along < 0) { nx = -nx; ny = -ny; along = -along; }
      const cut = (((g.ax - nodeX) * nx + (g.ay - nodeY) * ny) + g.half) / along;
      if (!found || cut > found.cut) found = { cut, tx, ty, state: g.state };
    }
    return found;
  }

  /** Geometria nawierzchni po przycięciu końców; oś OSM, linie przebiegu i poziomy pozostają bez zmian. */
  _fillShape(state, points, z, joins) {
    if (!joins || !state.interp.classDef.surfaced || state.interp.classDef.stairs || !Array.from(z).every(Number.isFinite)) return { xy: points, z, joins };
    let list = Array.from(z, (h, i) => [points[i * 3], points[i * 3 + 1], points[i * 3 + 2], h]);
    const start = this._fillEnd(state, true), end = this._fillEnd(state, false);
    const trim = (items, { cut = 0, extend = 0 }) => {
      const node = items[0];
      if (extend) { const l = Math.hypot(items[1][0] - node[0], items[1][1] - node[1]) || 1; return [[node[0] - ((items[1][0] - node[0]) / l) * extend, node[1] - ((items[1][1] - node[1]) / l) * extend, node[2], node[3]], ...items]; }
      if (!cut) return items;
      let left = cut;
      for (let i = 1; i < items.length; i += 1) {
        const a = items[i - 1], b = items[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (left < l) { const k = left / l, g = a[2] === null || b[2] === null ? null : a[2] + (b[2] - a[2]) * k; return [[a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, g, node[3]], ...items.slice(i)]; }
        left -= l;
      }
      return items;
    };
    const total = list.slice(1).reduce((sum, q, i) => sum + Math.hypot(q[0] - list[i][0], q[1] - list[i][1]), 0);
    const fits = total - (start.cut ?? 0) - (end.cut ?? 0) >= MIN_FILL_METERS;
    const startEnd = !start.cut || fits ? start : { join: { type: "junction" } }, endEnd = !end.cut || fits ? end : { join: { type: "junction" } };
    list = trim(list, startEnd); list = trim(list.reverse(), endEnd).reverse();
    return { xy: list.flatMap((q) => [q[0], q[1], q[2]]), z: Float32Array.from(list, (q) => q[3]), joins: { start: startEnd.join, end: endEnd.join } };
  }

  /** Obrys mostu i połączenia zależą od sąsiadów, więc zmiana trasy przebudowuje także ich kawałki. */
  refresh(ids) {
    this.buildingCells = null; this.plates = null; this.plateStates = null; this.plateLines = null;
    this.joints = null; this.coverGrid = null; this.clearance = null; this.furniture?.invalidate();
    const keys = this._affected(ids);
    for (const key of keys) this.rebuild(this.chunks.get(key));
    return keys.size;
  }

  /** Kawałki do przebudowy po zmianie obiektów: ich własne, obrysów, w których leżą, bram i sąsiadów we wspólnych węzłach. */
  _affected(ids) {
    const keys = new Set();
    const touched = new Set(ids);
    for (const pair of this.model.index.contained) if (touched.has(pair.line)) keys.add(this.model.states.get(pair.area).chunk);
    const joints = this._jointMap();
    keys.add(SUPPORT_CHUNK);
    for (const id of ids) {
      const state = this.model.states.get(id);
      keys.add(state.chunk);
      for (const way of this.model.barriers?.byId.get(id)?.wayIds ?? []) keys.add(this.model.states.get(way).chunk);
      for (const ref of state.feature.nodeRefs ?? []) for (const entry of joints.get(ref) ?? []) keys.add(entry.state.chunk);
    }
    return keys;
  }

  rebuild(chunk) {
    for (const mesh of chunk.meshes) { this.group.remove(mesh); mesh.geometry.dispose(); }
    chunk.meshes = [];
    const buckets = new Map();
    const bucket = (kind, def) => {
      const key = `${kind}|${def.group}|${def.tier}|${def.priority ?? 0}`;
      if (!buckets.has(key)) {
        const range = Number.isFinite(TIER_RANGE[def.tier]) ? TIER_RANGE[def.tier] : 0;
        buckets.set(key, Object.assign(new Buffers(kind, range), { group: def.group, tier: def.tier, priority: def.priority ?? 0 }));
      }
      return buckets.get(key);
    };
    if (chunk.key === SUPPORT_CHUNK) this._emitSupports(bucket);
    for (const id of chunk.ids) this._emit(this.model.states.get(id), bucket);
    for (const b of buckets.values()) {
      if (!b.count) continue;
      const geometry = new THREE.BufferGeometry();
      for (const [name, values] of Object.entries(b.a)) geometry.setAttribute(name, new THREE.Float32BufferAttribute(values, ITEM_SIZE[name] ?? 1).onUpload(releaseArray));
      if (b.kind !== "point") { geometry.setIndex(b.index); geometry.index.onUpload(releaseArray); }
      const Kind = b.kind === "point" ? THREE.Points : b.kind === "wire" ? THREE.LineSegments : THREE.Mesh;
      geometry.computeBoundingSphere();
      geometry.boundingSphere.radius += 60;
      const mesh = new Kind(geometry, this.materials[b.kind]);
      mesh.renderOrder = this.order[b.kind] + (3 - b.tier) + b.priority;
      mesh.userData = { group: b.group, tier: b.tier };
      mesh.visible = !this._groupHidden(b.group);
      chunk.meshes.push(mesh);
      this.unuploaded.push(mesh);
      this.group.add(mesh);
    }
    if (this.vegetation) this._emitVegetation(chunk);
  }

  /**
   * Rośliny obiektów kawałka (drzewa, szpalery, wypełnienie lasów i zarośli) trafiają do kolejki: obiekt × kwadrat 250 m.
   * Przebudowa kawałka unieważnia jego wcześniejsze zadania (nowy znacznik), a jego stare siatki zostały już usunięte.
   */
  _emitVegetation(chunk) {
    chunk.vegetationToken = {};
    for (const id of chunk.ids) {
      const state = this.model.states.get(id);
      if (!state?.interp.vegetation) continue;
      const f = state.feature, at = f.point ?? f.points;
      for (const clip of vegetationCells(state)) this.vegetationQueue.push({ chunk: chunk.key, token: chunk.vegetationToken, id, clip, x: clip ? (clip[0] + clip[2]) / 2 : at[0], y: clip ? (clip[1] + clip[3]) / 2 : at[1] });
    }
    this.vegetationSorted = false;
  }

  /** Wykonuje zadania roślinności przez `budgetMs`, od najbliższych punktu (x, y). Zwraca liczbę dodanych siatek. */
  buildVegetation(budgetMs, x, y) {
    if (!this.vegetationQueue.length) return 0;
    const started = performance.now();
    if (!this.vegetationSorted) {
      this.vegetationQueue.sort((a, b) => Math.hypot(b.x - x, b.y - y) - Math.hypot(a.x - x, a.y - y));
      this.vegetationSorted = true;
    }
    let added = 0;
    while (this.vegetationQueue.length && performance.now() - started < budgetMs) {
      const job = this.vegetationQueue.pop(), chunk = this.chunks.get(job.chunk), state = this.model.states.get(job.id);
      if (!chunk || chunk.vegetationToken !== job.token || !state?.interp.vegetation) continue;
      this.clearance ??= clearanceIndex(this.model, widthOf);
      const plants = plantsOf(state, this.vegetation.cfg, this.groundAt, this.clearance, job.clip);
      if (!plants.length) continue;
      for (const mesh of this.vegetation.meshes([{ plants, pick: this.pickColor(job.id) }], releaseArray)) {
        mesh.renderOrder = this.order.solid;
        mesh.visible = !this._groupHidden(mesh.userData.group);
        chunk.meshes.push(mesh);
        this.unuploaded.push(mesh);
        this.group.add(mesh);
        added += 1;
      }
    }
    return added;
  }

  /** @param style {half, minPx, color, neighbourStyle(state)}; @param joins połączenia na obu końcach lub null */
  _ribbon(b, xy, z, style, pick, { offset = 0, joins = null, junctionCaps = true, walls = null } = {}) {
    const n = xy.length / 3;
    let start = -1;
    const flush = (end) => {
      if (start >= 0 && end - start >= 2) {
        this._strip(b, xy, z, start, end, style, pick, offset, {
          first: start === 0 ? joins?.start ?? { type: "end" } : { type: "end" },
          last: end === n ? joins?.end ?? { type: "end" } : { type: "end" }, junctionCaps, walls,
        });
      }
      start = -1;
    };
    for (let i = 0; i < n; i += 1) {
      if (Number.isFinite(z[i])) { if (start < 0) start = i; } else flush(i);
    }
    flush(n);
  }

  _strip(b, xy, z, start, end, style, pick, offset, { first, last, junctionCaps, walls }) {
    const count = end - start;
    const distance = new Float64Array(count);
    for (let i = 1; i < count; i += 1) {
      const a = (start + i - 1) * 3, c = (start + i) * 3;
      distance[i] = distance[i - 1] + Math.hypot(xy[c] - xy[a], xy[c + 1] - xy[a + 1]);
    }
    const total = distance[count - 1];
    const taper = Math.min(TAPER_METERS, total / 2) || 1;
    const blend = (join) => {
      if (join.type !== "continuation" || style.halfAt) return null;
      if (join.forkWidth !== undefined) return { half: join.forkWidth / 2 + (style.grow ?? 0), minPx: style.minPx, color: style.color };
      const other = style.neighbourStyle(join.neighbour);
      return { half: (style.half + other.half) / 2, minPx: (style.minPx + other.minPx) / 2, color: other.sameGroup && !style.material ? mixColor(style.color, other.color, 0.5) : style.color };
    };
    const startBlend = blend(first), endBlend = blend(last);
    const at = (i) => {
      let half = style.halfAt ? style.halfAt(start + i) : style.half, minPx = style.minPx, col = style.color;
      for (const [target, s] of [[startBlend, distance[i]], [endBlend, total - distance[i]]]) {
        if (!target || s >= taper) continue;
        const t = 1 - s / taper;
        half += (target.half - style.half) * t; minPx += (target.minPx - style.minPx) * t;
        if (!style.material) col = mixColor(col, target.color, t);
      }
      const narrow = style.narrowAt?.(distance[i]) ?? 1;
      return { half: half * narrow, minPx: minPx * Math.max(narrow, CROSSING_LINE_MIN_PIXEL_SHARE), col };
    };
    const material = style.material;
    const vertex = (x, y, h, mx, my, side, v) => {
      b.push("position", x, y, h + offset);
      b.push("aMiter", mx, my); b.push("aSide", side); b.push("aHalf", v.half); b.push("aMinPx", v.minPx);
      b.push("aColor", ...v.col); b.push("aPick", ...pick); b.push("aRange", b.range);
      if (material) { b.push("aAccent", ...material.accent); b.push("aPattern", material.pattern); b.push("aUv", x + mx * v.half, y + my * v.half); } // Faktura w układzie świata jest ciągła między trasami.
      b.roles?.push(style.role ?? "fill");
      b.count += 1;
      return b.count - 1;
    };
    /** Wachlarz wokół punktu; leży w płaszczyźnie spadku trasy, więc nie wystaje nad jej nawierzchnię. */
    const fan = (x, y, h, v, fromX, fromY, sweep, segments, gx, gy) => {
      // Koło obwódki zostaje pod nawierzchnią także tam, gdzie zmienia się spadek trasy.
      const drop = style.role === "casing" ? Math.hypot(gx, gy) * v.half + 0.03 : 0;
      const centre = vertex(x, y, h - drop, 0, 0, 0, v);
      let previous = -1;
      for (let k = 0; k <= segments; k += 1) {
        const angle = (sweep * k) / segments, c = Math.cos(angle), s = Math.sin(angle);
        const mx = fromX * c - fromY * s, my = fromX * s + fromY * c;
        // Brzeg półkola wraca do wysokości krawędzi wstęgi, inaczej w widoku skośnym powstaje między nimi szczelina.
        const rimDrop = sweep < Math.PI * 1.5 ? drop * Math.sin(angle) : drop;
        const id = vertex(x, y, h - rimDrop + (gx * mx + gy * my) * v.half, mx, my, 0, v);
        if (previous >= 0) b.index.push(centre, previous, id);
        previous = id;
      }
    };
    const edgeRows = [];
    let previousRow = -1;
    for (let i = start; i < end; i += 1) {
      const x = xy[i * 3], y = xy[i * 3 + 1];
      const p = Math.max(start, i - 1), q = Math.min(end - 1, i + 1);
      let ax = x - xy[p * 3], ay = y - xy[p * 3 + 1], bx = xy[q * 3] - x, by = xy[q * 3 + 1] - y;
      if (i === start && first.type === "continuation") { ax = x - first.nx; ay = y - first.ny; if (first.square) { bx = ax; by = ay; } }
      if (i === end - 1 && last.type === "continuation") { bx = last.nx - x; by = last.ny - y; if (last.square) { ax = bx; ay = by; } }
      const al = Math.hypot(ax, ay), bl = Math.hypot(bx, by);
      if (al > 1e-6) { ax /= al; ay /= al; }
      if (bl > 1e-6) { bx /= bl; by /= bl; }
      if (al <= 1e-6) { ax = bx; ay = by; }
      if (bl <= 1e-6) { bx = ax; by = ay; }
      let mx = -(ay + by), my = ax + bx;
      const ml = Math.hypot(mx, my) || 1;
      mx /= ml; my /= ml;
      const v = at(i - start), row = b.count;
      // Ostre załamanie lub krótki odcinek przy szerokiej wstędze domyka koło zamiast długiego szpica fazy.
      const turn = ax * bx + ay * by;
      const run = distance[q - start] - distance[p - start];
      const chordX = xy[q * 3] - xy[p * 3], chordY = xy[q * 3 + 1] - xy[p * 3 + 1], chord = Math.hypot(chordX, chordY) || 1;
      // Krótki odcinek przy czole stopnia nie może nadawać zaokrągleniu pionowego nachylenia.
      const slope = run > 1e-6 ? Math.max(-MAX_FAN_SLOPE, Math.min(MAX_FAN_SLOPE, (z[q] - z[p]) / run)) : 0;
      const gx = (slope * chordX) / chord, gy = (slope * chordY) / chord;
      const sharp = i > start && i < end - 1 && (turn < SHARP_JOIN_COS || (Math.min(al, bl) < v.half * 1.5 && turn < 0.995));
      const scale = Math.min(2, 1 / Math.max(0.5, mx * -ay + my * ax));
      // Przy ostrym załamaniu każdy odcinek kończy się z własną normalną, więc zachowuje pełną szerokość.
      let [inX, inY] = sharp ? [-ay, ax] : [mx * scale, my * scale];
      // Koniec przycięty do krawędzi innej trasy biegnie wzdłuż tej krawędzi.
      const flush = i === start && first.type === "flush" ? first : i === end - 1 && last.type === "flush" ? last : null;
      if (flush) {
        const nx = i === start ? -by : -ay, ny = i === start ? bx : ax, dot = flush.tx * nx + flush.ty * ny, k = (Math.sign(dot) || 1) / (Math.abs(dot) || 1);
        inX = flush.tx * k; inY = flush.ty * k;
      }
      vertex(x, y, z[i], -inX, -inY, -1, v);
      vertex(x, y, z[i], inX, inY, 1, v);
      if (previousRow >= 0) b.index.push(previousRow, previousRow + 1, row + 1, previousRow, row + 1, row);
      previousRow = row;
      edgeRows.push({ i, x, y, z: z[i] + offset, mx: inX, my: inY, half: v.half });
      if (sharp) {
        fan(x, y, z[i], v, 1, 0, Math.PI * 2, 14, gx, gy);
        previousRow = b.count;
        vertex(x, y, z[i], by, -bx, -1, v);
        vertex(x, y, z[i], -by, bx, 1, v);
        edgeRows.push({ i, x, y, z: z[i] + offset, mx: -by, my: bx, half: v.half });
      }
      const capped = (join) => !style.noCaps && (join.type === "end" || (join.type === "junction" && junctionCaps));
      // Półkole od jednej krawędzi przez kierunek na zewnątrz do drugiej: bez wystających narożników.
      if (i === start && capped(first)) fan(x, y, z[i], v, -by, bx, Math.PI, capSegments(v.half), gx, gy);
      if (i === end - 1 && capped(last)) fan(x, y, z[i], v, ay, -ax, Math.PI, capSegments(v.half), gx, gy);
    }
    if (walls) this._edgeWalls(walls, edgeRows, xy, pick);
  }

  _solidVertex(b, x, y, z, normal, col, pick, ao) {
    b.push("position", x, y, z); b.push("normal", ...normal); b.push("aColor", ...col); b.push("aPick", ...pick); b.push("aAo", ao); b.push("aRange", b.range);
    b.count += 1;
  }

  /**
   * Pomost jako zamknięta płyta stałej grubości: boki wychodzą z krawędzi nawierzchni, a od spodu zamyka je podsufitka.
   * Ściany nie sięgają do gruntu; to, co niesie pomost, jest osobnym obiektem podpory.
   */
  _edgeWalls({ bucket: b, color: col, thickness }, rows, xy, pick) {
    const bottomAt = (row) => Math.max(Math.min(xy[row.i * 3 + 2] ?? row.z, row.z), row.z - thickness);
    const edges = { [-1]: [], 1: [] };
    for (const side of [-1, 1]) {
      let previous = null, previousTall = false;
      for (const row of rows) {
        const ox = row.mx * side, oy = row.my * side, length = Math.hypot(ox, oy) || 1;
        const x = row.x + ox * row.half, y = row.y + oy * row.half, normal = [ox / length, oy / length, 0];
        const bottom = bottomAt(row), tall = row.z - bottom > MIN_WALL_HEIGHT, start = b.count;
        this._solidVertex(b, x, y, row.z, normal, col, pick, 1);
        this._solidVertex(b, x, y, bottom, normal, col, pick, 0.25);
        if (previous !== null && (tall || previousTall)) b.index.push(previous, previous + 1, start + 1, previous, start + 1, start);
        previous = start; previousTall = tall;
        edges[side].push({ x, y, z: bottom, tall });
      }
    }
    let previous = null;
    rows.forEach((_, i) => {
      const left = edges[-1][i], right = edges[1][i], start = b.count, tall = left.tall && right.tall;
      this._solidVertex(b, left.x, left.y, left.z, [0, 0, -1], col, pick, 0.25);
      this._solidVertex(b, right.x, right.y, right.z, [0, 0, -1], col, pick, 0.25);
      if (previous !== null && tall && previous.tall) b.index.push(previous.start, previous.start + 1, start + 1, previous.start, start + 1, start);
      previous = { start, tall };
    });
  }

  /**
   * Dół podpory na rysowanym terenie: dopasowanie terenu do tras może go obniżyć względem NMT,
   * więc stopa schodzi do najniższego punktu terenu pod sobą, aby podpora nie wisiała.
   */
  supportBottom(s) {
    let low = s.bottom;
    for (let k = 0; k <= 8; k += 1) {
      const r = k ? s.radius * 1.45 : 0, a = (k * Math.PI) / 4, g = this.groundAt?.(s.x + r * Math.cos(a), s.y + r * Math.sin(a));
      if (Number.isFinite(g) && g < low) low = g;
    }
    return low < s.bottom ? low - SUPPORT_SINK_METERS : s.bottom;
  }

  /** Podpory jako osobne pionowe bryły: stopa na terenie, słup i oczep pod spodem pomostu. */
  _emitSupports(bucket) {
    const octagon = (x, y, r) => Array.from({ length: 8 }, (_, i) => new THREE.Vector2(x + r * Math.cos((i * Math.PI) / 4), y + r * Math.sin((i * Math.PI) / 4)));
    for (const s of this.model.supports?.items ?? []) {
      const def = this.model.profile.classes[s.source === "osm" ? "structure.support" : "structure.inferred_support"];
      const bottom = this.supportBottom(s), b = bucket("solid", def), col = rgb(def.color), pick = this.pickColor(s.id), height = s.top - bottom;
      if (height <= 0) continue;
      const capHeight = Math.min(0.7, height * 0.3), footHeight = height > 1.6 ? 0.25 : 0;
      this._prism(b, [octagon(s.x, s.y, s.radius)], () => s.top - capHeight, () => bottom + footHeight, col, pick);
      if (footHeight) this._prism(b, [octagon(s.x, s.y, s.radius * 1.45)], () => bottom + footHeight, () => bottom, col, pick);
      const across = Math.max(s.radius * 1.5, Math.min(s.deckWidth * 0.38, 4.5)), along = s.radius * 1.15;
      const nx = -s.ty, ny = s.tx;
      const cap = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => new THREE.Vector2(s.x + s.tx * along * u + nx * across * v, s.y + s.ty * along * u + ny * across * v));
      this._prism(b, [cap], () => s.top, () => s.top - capHeight, col, pick);
    }
  }

  /** Bieg schodów jako bryły stopni i spoczników; każdy ma nawierzchnię, czoło, boki i spód. */
  _emitStairs(state, plan, bucket, pick) {
    const def = state.interp.classDef, b = bucket("stairs", def), half = plan.width / 2;
    const color = rgb(plan.material.color), accent = rgb(plan.material.accent), patternId = STAIR_PATTERNS.indexOf(plan.material.pattern);
    const vertex = (p, normal, u, v, ao) => {
      b.push("position", ...p); b.push("normal", ...normal); b.push("aColor", ...color); b.push("aAccent", ...accent); b.push("aPick", ...pick);
      b.push("aUv", u, v); b.push("aPattern", patternId); b.push("aAo", ao); b.push("aRange", b.range);
      b.count += 1;
    };
    const quad = (corners, normal, uvs, aos) => {
      const start = b.count;
      corners.forEach((p, i) => vertex(p, normal, uvs[i][0], uvs[i][1], aos[i]));
      b.index.push(start, start + 1, start + 2, start, start + 2, start + 3);
    };
    const frame = (d) => {
      const p = stairPoint(plan, plan.toWay(d)), sign = plan.uphillForward ? 1 : -1, tx = p.tx * sign, ty = p.ty * sign, nx = -ty, ny = tx;
      return { ...p, tx, ty, nx, ny, left: (z) => [p.x - nx * half, p.y - ny * half, z], right: (z) => [p.x + nx * half, p.y + ny * half, z] };
    };
    for (const segment of plan.segments) {
      const length = segment.to - segment.from, pieces = Math.max(1, Math.ceil(length / STAIR_PIECE_METERS));
      const under = Math.min(segment.bottom, segment.z) - STAIR_SOFFIT;
      for (let i = 0; i < pieces; i += 1) {
        const d0 = segment.from + (length * i) / pieces, d1 = segment.from + (length * (i + 1)) / pieces, a = frame(d0), c = frame(d1), z = segment.z;
        quad([a.left(z), a.right(z), c.right(z), c.left(z)], [0, 0, 1], [[0, d0], [plan.width, d0], [plan.width, d1], [0, d1]], [1, 1, 1, 1]);
        quad([a.left(under), c.left(under), c.right(under), a.right(under)], [0, 0, -1], [[0, d0], [0, d1], [plan.width, d1], [plan.width, d0]], [0.4, 0.4, 0.4, 0.4]);
        for (const [side, edge] of [[-1, "left"], [1, "right"]]) {
          quad([a[edge](under), c[edge](under), c[edge](z), a[edge](z)], [a.nx * side, a.ny * side, 0], [[d0, under], [d1, under], [d1, z], [d0, z]], [0.45, 0.45, 1, 1]);
        }
        if (i === 0) quad([a.left(under), a.right(under), a.right(z), a.left(z)], [-a.tx, -a.ty, 0], [[0, under], [plan.width, under], [plan.width, z], [0, z]], [0.55, 0.55, 0.95, 0.95]);
        if (i === pieces - 1) quad([c.right(under), c.left(under), c.left(z), c.right(z)], [c.tx, c.ty, 0], [[0, under], [plan.width, under], [plan.width, z], [0, z]], [0.55, 0.55, 0.95, 0.95]);
      }
    }
  }

  /** Oś linii trasy biegnie po krawędziach stopni, więc leży nad materiałem i nie miesza się z nim. */
  _stairLine(plan) {
    // Przy pionowym czole linia wchodzi na krawędź stopnia tuż za nim, zamiast przechodzić pod nawierzchnią.
    const stations = [[0, plan.segments[0].bottom]];
    const add = (d, height) => {
      const last = stations[stations.length - 1];
      if (Math.abs(height - last[1]) < 1e-6 && d - last[0] < 1e-3) return;
      stations.push([Math.max(d, last[0] + STAIR_LINE_STEP), height]);
    };
    // Na odcinku po nawierzchni dojścia linia biegnie płasko od węzła do pierwszego stopnia.
    if (plan.lowTrim > 0) add(plan.lowTrim, plan.segments[0].bottom);
    for (const segment of plan.segments) {
      add(segment.from, segment.z);
      if (segment.kind === "landing" || segment === plan.segments[plan.segments.length - 1]) add(segment.to, segment.z);
    }
    if (plan.highTrim > 0) add(plan.length, plan.segments[plan.segments.length - 1].z);
    const xy = [], z = [];
    for (const [d, height] of stations) { const p = stairPoint(plan, plan.toWay(Math.min(d, plan.length))); xy.push(p.x, p.y, 0); z.push(height); }
    return { xy, z: Float32Array.from(z) };
  }

  _materialStyle(material) {
    return { accent: rgb(material.accent), pattern: Math.max(0, STAIR_PATTERNS.indexOf(material.pattern)) };
  }

  /** Oznakowanie powstaje wyłącznie z planu opartego na tagach; każda kreska jest osobną cienką wstęgą. */
  /** Oznakowanie dzieli kolejność rysowania z nawierzchnią, na której leży: na gruncie albo na pomoście. */
  _markingBucket(bucket, raised = false) {
    return bucket(raised ? "mark" : "markGround", { group: MARKING_GROUP, tier: 2 });
  }

  _axisFrame(plan, z, s) {
    const p = stairPoint({ points: plan.axis, along: plan.along }, Math.max(0, Math.min(plan.length, s)));
    let i = 1;
    while (i < plan.along.length - 1 && plan.along[i] < s) i += 1;
    const span = plan.along[i] - plan.along[i - 1] || 1, t = Math.max(0, Math.min(1, (s - plan.along[i - 1]) / span));
    return { x: p.x, y: p.y, tx: p.tx, ty: p.ty, rx: p.ty, ry: -p.tx, z: z[i - 1] + (z[i] - z[i - 1]) * t };
  }

  /**
   * Punkty odsunięte o `o` (w prawo) od osi w miejscu s, tak jak krawędź nawierzchni: w wierzchołku osi wzdłuż ukosu,
   * a przy ostrym załamaniu (ta sama reguła co w _strip, dla połowy szerokości `half`) po łuku między normalnymi odcinków.
   */
  _offsetPoints(plan, z, s, o, half = 0) {
    const f = this._axisFrame(plan, z, s), { along, axis } = plan, n = along.length;
    let k = -1;
    for (let i = 1; i < n - 1; i += 1) if (Math.abs(along[i] - s) < 1e-6) { k = i; break; }
    if (k < 0 || !o) return [[f.x + f.rx * o, f.y + f.ry * o, f.z]];
    const dir = (i) => { const dx = axis[i * 3 + 3] - axis[i * 3], dy = axis[i * 3 + 4] - axis[i * 3 + 1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l, l]; };
    const [ax, ay, al] = dir(k - 1), [bx, by, bl] = dir(k), px = axis[k * 3], py = axis[k * 3 + 1];
    const turn = ax * bx + ay * by;
    // Po zewnętrznej stronie ostrego załamania nawierzchnia ma łuk; po wewnętrznej jej bok to przecięcie odsuniętych krawędzi (ukos niżej).
    const outer = o * (ax * by - ay * bx) > 0;
    if (outer && (turn < SHARP_JOIN_COS || (Math.min(al, bl) < half * 1.5 && turn < 0.995))) {
      // Normalne odcinków (w prawo) i łuk między nimi.
      const from = Math.atan2(-ax, ay), to = Math.atan2(-bx, by);
      let sweep = to - from;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;
      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / 0.2));
      return Array.from({ length: steps + 1 }, (_, i) => { const a = from + (sweep * i) / steps; return [px + Math.cos(a) * o, py + Math.sin(a) * o, f.z]; });
    }
    const ml = Math.hypot(ay + by, -ax - bx);
    if (ml < 1e-6) return [[f.x + f.rx * o, f.y + f.ry * o, f.z]];
    // Po wewnętrznej stronie ostrego załamania punkt przecięcia leży dalej niż ograniczony ukos wstęgi; bez ograniczenia trafia w bok nawierzchni.
    const cos = Math.max(0.05, (ay + by) / ml * ay + (-ax - bx) / ml * -ax), sharp = turn < SHARP_JOIN_COS || (Math.min(al, bl) < half * 1.5 && turn < 0.995);
    const mx = (ay + by) / ml, my = (-ax - bx) / ml, scale = sharp ? 1 / cos : Math.min(2, 1 / Math.max(0.5, cos));
    return [[px + mx * o * scale, py + my * o * scale, f.z]];
  }

  /** Stacje kreski od a do b z wierzchołkami osi pomiędzy, aby kreska na łuku nie ścinała zakrętu. */
  _stations(plan, a, b) { return [a, ...plan.along.filter((s) => s > a + 1e-6 && s < b - 1e-6), b]; }

  _markStroke(b, stroke, half, color, pick, minPx) {
    const xy = [], heights = [];
    for (const [x, y, h] of stroke) { xy.push(x, y, 0); heights.push(h); }
    const style = { role: "marking", half, minPx, color, noCaps: true, neighbourStyle: () => ({ half, minPx, color, sameGroup: true }) };
    this._ribbon(b, xy, Float32Array.from(heights), style, pick, { offset: 0.06 });
  }

  _emitWayMarkings(plan, z, pick, bucket, raised = false, fillHalfAt = null, taper = 0) {
    const cfg = this.model.profile.surfaces;
    if (!plan.dividers.length && !plan.arrows.length && !plan.crossing?.spans.length && !plan.edgeLine?.sides.length) return;
    const b = this._markingBucket(bucket, raised), half = cfg.markingWidthMeters / 2, solid = rgb(cfg.markingColor), assumed = rgb(cfg.assumedMarkingColor), minPx = cfg.markingMinPixels;
    // Linie krawędziowe: ciągłe, przy krawędzi rysowanej jezdni, także na odcinku o zmiennej szerokości.
    for (const { side, pieces } of plan.edgeLine?.sides ?? []) {
      // Linia leży kawałek od brzegu: za nią zostaje pas asfaltu, więc nie zlewa się z jasnym terenem obok jezdni.
      const lineHalf = cfg.edgeLineWidthMeters / 2, inset = cfg.edgeLineInsetMeters ?? 0;
      // Przejście przez jezdnię (malowane i nieoznakowane) przerywa linię krawędziową na swojej szerokości.
      const cut = pieces.flatMap((piece) => (plan.crossZones ?? plan.coreZones).reduce((list, [a, b]) => list.flatMap(([x, y]) => (y <= a || x >= b ? [[x, y]] : [[x, Math.min(y, a)], [Math.max(x, b), y]])), [piece])).filter(([x, y]) => y - x >= EDGE_LINE_MIN_METERS);
      for (const [from, to] of cut) {
        const stations = new Set([from, to]);
        for (let s = Math.ceil(from / EDGE_LINE_STEP_METERS) * EDGE_LINE_STEP_METERS; s < to; s += EDGE_LINE_STEP_METERS) stations.add(s);
        for (const s of plan.along) if (s > from && s < to) stations.add(s);
        // Nawierzchnia ma szerokość liczoną w wierzchołkach osi i liniową między nimi; linia robi tak samo.
        const vertexHalf = (k) => fillHalfAt?.(plan.along[k]) ?? (transitionWidthAt(plan, plan.along[k]) ?? plan.width) / 2;
        const halfAt = (s) => {
          let k = 1;
          while (k < plan.along.length - 1 && plan.along[k] < s) k += 1;
          const a = plan.along[k - 1], b = plan.along[k], f = b > a ? Math.max(0, Math.min(1, (s - a) / (b - a))) : 0;
          return vertexHalf(k - 1) + (vertexHalf(k) - vertexHalf(k - 1)) * f;
        };
        const stroke = [...stations].sort((p, q) => p - q).flatMap((s) => this._offsetPoints(plan, z, s, side * (halfAt(s) - inset - lineHalf), halfAt(s)));
        this._markStroke(b, stroke, lineHalf, plan.edgeLine.confirmed ? solid : assumed, pick, minPx);
      }
    }
    for (const divider of plan.dividers) {
      for (const dash of divider.dashes) {
        // Na odcinku przejściowym linia pasa podąża za zmienną szerokością jezdni.
        const offsetAt = (d) => (plan.transition || plan.laneWidths ? laneOffset(plan, divider.lane, d, cfg.drivingSide) : null) ?? divider.offset;
        const stroke = this._stations(plan, dash[0], dash[1]).flatMap((d) => this._offsetPoints(plan, z, d, offsetAt(d), fillHalfAt?.(d) ?? plan.width / 2));
        this._markStroke(b, stroke, half, divider.confirmed ? solid : assumed, pick, minPx);
      }
    }
    const scale = Math.min(1, (plan.laneWidth ?? 3.25) / cfg.laneWidthMeters);
    for (const arrow of plan.arrows) {
      const f = this._axisFrame(plan, z, arrow.s), tx = f.tx * arrow.travel, ty = f.ty * arrow.travel, rx = ty, ry = -tx;
      const lanes = plan.transition || plan.laneWidths ? [laneOffset(plan, arrow.lane, arrow.s, cfg.drivingSide), laneOffset(plan, arrow.lane + 1, arrow.s, cfg.drivingSide)] : null;
      const offset = lanes?.[0] !== null && lanes?.[0] !== undefined ? (lanes[0] + lanes[1]) / 2 : arrow.offset;
      const ox = f.x + f.rx * offset - tx * 1.7 * scale, oy = f.y + f.ry * offset - ty * 1.7 * scale;
      const point = ([u, v]) => [ox + (tx * u + rx * v) * scale, oy + (ty * u + ry * v) * scale, f.z];
      for (const turn of arrow.turns) {
        const path = ARROW_PATHS[turn];
        if (!path) continue;
        this._markStroke(b, path.map(point), half * 1.25, solid, pick, minPx);
        const tip = path[path.length - 1], before = path[path.length - 2], du = tip[0] - before[0], dv = tip[1] - before[1], l = Math.hypot(du, dv) || 1;
        for (const sign of [-1, 1]) {
          const c = Math.cos(2.55), s = Math.sin(2.55) * sign, hu = (du * c - dv * s) / l, hv = (du * s + dv * c) / l;
          this._markStroke(b, [tip, [tip[0] + hu * 0.75, tip[1] + hv * 0.75]].map(point), half * 1.25, solid, pick, minPx);
        }
      }
    }
    // Malowanie obejmuje tylko odcinki leżące na jezdni, a nie wyspy i pasy rozdziału.
    if (plan.crossing?.spans.length) {
      // Malowanie jest proste na całym odcinku, także gdy way załamuje się w węźle na jezdni.
      const chords = plan.crossing.spans.map(([from, to]) => {
        const a = this._axisFrame(plan, z, from), c = this._axisFrame(plan, z, to), l = Math.hypot(c.x - a.x, c.y - a.y) || 1;
        return { from, to, a, c, tx: (c.x - a.x) / l, ty: (c.y - a.y) / l };
      });
      this._crossingMarks(b, plan.crossing, plan.crossing.spans, pick, (s, lateral) => {
        const span = chords.find((item) => s >= item.from - 1e-6 && s <= item.to + 1e-6) ?? chords[0], k = (s - span.from) / (span.to - span.from || 1);
        return [span.a.x + (span.c.x - span.a.x) * k + span.ty * lateral, span.a.y + (span.c.y - span.a.y) * k - span.tx * lateral, this._axisFrame(plan, z, s).z];
      }, this.model.states.get(plan.id));
    }
  }

  /** Wzory przejść w układzie: `s` wzdłuż kierunku przechodzenia, `lateral` w poprzek niego. */
  _crossingMarks(b, crossing, spans, pick, at, self = null) {
    const cfg = this.model.profile.surfaces, minPx = cfg.markingMinPixels;
    for (const part of crossing.parts) {
      const color = rgb(part.approximate ? cfg.assumedMarkingColor : cfg.markingColor), { offset, half } = part;
      for (const [from, to, compact] of part.spans ?? spans) {
        if (part.pattern === "zebra") {
          // Na ścieżce pasy są drobniejsze i mieszczą się w szerokości przejścia.
          const period = compact ? cfg.crossingCompactPeriodMeters : cfg.crossingPeriodMeters, stripe = compact ? cfg.crossingCompactStripeMeters : cfg.crossingStripeMeters, reach = compact ? crossing.compactHalf : half;
          for (let s = from + period / 2; s < to; s += period) {
            let low = offset - reach, high = offset + reach;
            if (compact) {
              // Skośne przecięcie: pas kończy się na krawędzi ścieżki, a nie na terenie obok niej.
              const inside = [];
              for (let l = low; l <= high + 1e-6; l += STRIPE_CLIP_STEP_METERS) { const [px, py, h] = at(s, l); if (this._onSurface(px, py, h, self)) inside.push(l); }
              if (inside.length < 2 || inside[inside.length - 1] - inside[0] < MIN_STRIPE_METERS) continue;
              low = inside[0]; high = inside[inside.length - 1];
            }
            this._markStroke(b, [at(s, low), at(s, high)], stripe / 2, color, pick, minPx);
          }
        } else if (part.pattern === "blocks") {
          const size = cfg.crossingBlockMeters;
          for (const side of [-1, 1]) {
            const row = offset + side * (half - size / 2);
            for (let s = from + size / 2; s < to; s += size * 2) {
              const [px, py, h] = at(s, row);
              if (compact && !this._onSurface(px, py, h, self)) continue;
              this._markStroke(b, [at(s, row - size / 2), at(s, row + size / 2)], size / 2, color, pick, minPx);
            }
          }
        } else {
          for (const side of [-1, 1]) {
            const count = Math.max(1, Math.ceil(to - from)), stroke = [];
            for (let i = 0; i <= count; i += 1) stroke.push(at(from + ((to - from) * i) / count, offset + side * half));
            this._markStroke(b, stroke, cfg.markingWidthMeters / 2, color, pick, minPx);
          }
        }
      }
    }
  }

  _emitNodeCrossing(crossing, pick, bucket) {
    const { x, y, z, tx, ty, half } = crossing, rx = ty, ry = -tx;
    this._crossingMarks(this._markingBucket(bucket), crossing, [[-half, half]], pick, (s, lateral) => [x + rx * s + tx * lateral, y + ry * s + ty * lateral, z]);
  }

  /** Linia trasy z dodatkowymi punktami przy przejściach; tam zwęża się, aby nie konkurować z malowaniem. */
  _lineThroughCrossings(points, z, zones) {
    const n = points.length / 3, along = [0];
    for (let i = 1; i < n; i += 1) along.push(along[i - 1] + Math.hypot(points[i * 3] - points[(i - 1) * 3], points[i * 3 + 1] - points[(i - 1) * 3 + 1]));
    const length = along[n - 1], taper = CROSSING_LINE_TAPER_METERS, ratio = this.model.profile.surfaces.routeLineCrossingRatio;
    const extra = zones.flatMap(([a, b]) => [a - taper, a, b, b + taper]).filter((s) => s > 0 && s < length);
    const stations = [...new Set([...along, ...extra])].sort((a, b) => a - b).filter((s, i, list) => !i || s - list[i - 1] > 1e-3);
    const xy = [], heights = [];
    let k = 1;
    for (const s of stations) {
      while (k < n - 1 && along[k] < s) k += 1;
      const t = Math.max(0, Math.min(1, (s - along[k - 1]) / (along[k] - along[k - 1] || 1)));
      xy.push(points[(k - 1) * 3] + (points[k * 3] - points[(k - 1) * 3]) * t, points[(k - 1) * 3 + 1] + (points[k * 3 + 1] - points[(k - 1) * 3 + 1]) * t, 0);
      heights.push(z[k - 1] + (z[k] - z[k - 1]) * t);
    }
    const inside = (s) => zones.some(([a, b]) => s >= a - 1e-3 && s <= b + 1e-3);
    const narrowAt = (s) => zones.reduce((value, [a, b]) => {
      const outside = Math.max(a - s, s - b, 0);
      return Math.min(value, outside >= taper ? 1 : ratio + (1 - ratio) * (outside / taper));
    }, 1);
    return { xy, z: Float32Array.from(heights), narrowAt, withoutZones: Float32Array.from(heights, (h, i) => (inside(stations[i]) ? NaN : h)) };
  }

  _routeColour(state) {
    for (const relation of state.feature.relations) {
      if (!["hiking", "foot", "bicycle"].includes(relation.route)) continue;
      const tags = this.model.relations.get(relation.id)?.tags ?? {};
      const raw = (tags.colour ?? tags["osmc:symbol"]?.split(":")[0] ?? "").toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
      if (ROUTE_COLOURS[raw]) return ROUTE_COLOURS[raw];
    }
    return null;
  }

  _emit(state, bucket) {
    const { feature, interp, level } = state;
    const def = interp.classDef;
    const pick = this.pickColor(feature.id);
    if (def.render === "support" && (feature.geometry !== "point" || this.model.supports?.byId.has(feature.id))) return;
    if (feature.geometry === "point") {
      if (feature.point[2] === null) return;
      // Drzewo jest bryłą w warstwie roślinności, nie znacznikiem; latarnie, maszty i słupy linii są bryłami.
      if (interp.vegetation && this.vegetation) return;
      if (this.furniture) {
        const kit = bucket("solid", { group: def.group, tier: 3 });
        if (interp.classId === LAMP) { this.furniture.lamp(state, kit, pick); return; }
        if (interp.classId === FLOODLIGHT) { this.furniture.floodlight(state, kit, pick); return; }
        if (interp.classId === ENTRANCE && this.furniture.door(state, kit, pick)) return;
        if (interp.classId === POLE && this.furniture.support(state, kit, bucket("wire", { group: "power", tier: 3 }), pick)) return;
      }
      const barrierNode = this.model.barriers?.byId.get(feature.id);
      if (barrierNode) { this._emitBarrierNode(state, barrierNode, bucket, pick); return; }
      const crossing = this.model.surfaces?.crossings.get(feature.id);
      if (crossing) this._emitNodeCrossing(crossing, pick, bucket);
      const b = bucket("point", def);
      b.push("position", feature.point[0], feature.point[1], feature.point[2] + 1.5);
      b.push("aColor", ...rgb(def.color)); b.push("aPick", ...pick);
      b.push("aSize", def.tier >= 3 ? 4 : 6); b.push("aShape", 0); b.push("aRange", b.range);
      b.count += 1;
      return;
    }
    const asArea = interp.geometry === "area";
    // Boisko i bieżnia: kolor nawierzchni jest w nakładce terenu, a linie i wyposażenie są bryłami nad nim.
    if (asArea && this.furniture && interp.classId === PITCH) this.furniture.pitch(state, bucket("pitchMark", { group: def.group, tier: 3 }), bucket("solid", { group: def.group, tier: 3 }), pick);
    if (asArea && this.furniture && interp.classId === TRACK) this.furniture.track(state, bucket("pitchMark", { group: def.group, tier: 3 }), pick);
    if (asArea && def.render === "area") return;
    // Linia napowietrzna: przewody między słupami zamiast linii w rzucie.
    if (this.furniture && interp.classId === POWER_LINE) { this.furniture.powerLine(state, bucket("wire", { group: def.group, tier: 2 }), pick); return; }
    // Obrys budynku z częściami building:part nie jest bryłą: bryłami są części (Simple 3D Buildings).
    if (asArea && def.render === "extrude") { if (!this.model.buildingParts?.hidden.has(feature.id)) this._extrude(state, bucket("solid", def), pick); return; }
    if (asArea && def.render === "structure") { this._structure(state, bucket("structure", def), pick); return; }
    if (feature.geometry !== "way") return;
    const barrierWay = this.model.barriers?.byId.get(feature.id);
    if (barrierWay) { this._emitBarrierWay(state, barrierWay, bucket, pick); return; }

    const sourcePoints = feature.points;
    const points = this.axisOf(state);
    const tunnel = this.model.tunnels?.byId.get(feature.id);
    const z = tunnel?.floor ?? level?.z ?? this._ground(sourcePoints);
    const half = widthOf(state) / 2, minPx = def.minPixels ?? 1;
    const surfaceOf = (s) => this.model.surfaces?.byId.get(s.feature.id)?.material ?? { color: s.interp.classDef.color, accent: s.interp.classDef.casing ?? s.interp.classDef.color, pattern: "solid" };
    const material = surfaceOf(state), surfacePlan = this.model.surfaces?.byId.get(feature.id);
    // Jezdnia z linią krawędziową nie ma ciemnej obwódki: jej brzeg wyznacza biała linia.
    const edgeColor = (s) => (this.model.surfaces?.byId.get(s.feature.id)?.edgeLine ? rgb(surfaceOf(s).color) : rgb(s.interp.classDef.surfaced ? surfaceOf(s).accent : s.interp.classDef.casing ?? "#cfcac0"));
    const casingColor = edgeColor(state);
    const joins = isRibbonWay(state) ? { start: this._joinAt(state, true), end: this._joinAt(state, false) } : null;
    // Sąsiad będący odcinkiem przejściowym albo pniem lub gałęzią rozwidlenia ma na styku szerokość tej jezdni, więc szerokość się nie zmienia.
    // Sąsiad z szerokością z width:lanes lub odcinka przejściowego ma na styku właściwą szerokość: ta jezdnia nie dostosowuje się do jego średniej.
    const keepsWidth = (other) => { const p = this.model.surfaces?.byId.get(other.feature.id); return Boolean(p?.transition || p?.laneWidths || surfacePlan?.forkPeers?.has(other.feature.id)); };
    const neighbourFill = (other) => ({ half: keepsWidth(other) ? half : widthOf(other) / 2, minPx: other.interp.classDef.minPixels ?? 1, color: rgb(surfaceOf(other).color), sameGroup: other.interp.classDef.group === def.group });
    // Odcinek przejściowy (placement=transition) zmienia szerokość liniowo na całej długości; szerokości końców ustala plan nawierzchni.
    const transitionHalf = surfacePlan?.widthStart !== undefined ? (k, grow = 0) => transitionWidthAt(surfacePlan, surfacePlan.along[k]) / 2 + grow : null;
    const fill = { half, minPx, color: rgb(material.color), material: this._materialStyle(material), neighbourStyle: neighbourFill, halfAt: transitionHalf && ((k) => transitionHalf(k)) };
    // Jezdnia z linią krawędziową nie ma obwódki wokół nawierzchni: obwódka zostaje pod nią (ściany pomostu, wypełnienie styków),
    // ale nie wystaje, więc na skrzyżowaniu nie przykrywa sąsiedniej nawierzchni innym odcieniem.
    const grow = surfacePlan?.edgeLine ? 0 : CASING_GROW, growPx = surfacePlan?.edgeLine ? 0 : CASING_GROW_PX;
    const casing = {
      role: "casing", grow, half: half + grow, minPx: minPx + growPx, color: casingColor, halfAt: transitionHalf && ((k) => transitionHalf(k, grow)),
      neighbourStyle: (other) => {
        const base = neighbourFill(other), otherGrow = this.model.surfaces?.byId.get(other.feature.id)?.edgeLine ? 0 : CASING_GROW;
        return { half: base.half + Math.min(grow, otherGrow), minPx: base.minPx + growPx, color: edgeColor(other), sameGroup: base.sameGroup };
      },
    };
    const shape = this._fillShape(state, points, z, joins);
    // Tylko nawierzchnia jezdni oznacza piksele, w których może leżeć oznakowanie jezdni.
    const fillKind = (kind) => (def.carriageway ? kind : `${kind}Other`);
    // Tunel leży pod terenem, więc jego przebieg jest rysowany na powierzchni.
    const atSurface = (xy, heights) => Float32Array.from(heights, (h, i) => Math.max(h, xy[i * 3 + 2] ?? h));
    // Trasa nad terenem jest bryłą z zapisem głębi; inaczej jej boki widać przez nawierzchnię.
    const plan = def.stairs ? this.model.stairs?.byId.get(feature.id) : null;
    const elevated = !plan && !tunnel && this._isElevated(state);
    if (tunnel) this._emitTunnel(state, tunnel, bucket, pick);
    if (plan) {
      // Schody są wyłącznie bryłą: płaska wstęga pod nimi wystawałaby poza stopnie przy końcach biegu.
      this._emitStairs(state, plan, bucket, pick);
      const line = this._stairLine(plan), color = rgb(plan.overlay.color);
      const overlay = { role: "mark", half: plan.overlay.half, minPx: plan.overlay.minPixels, color, neighbourStyle: () => ({ half: plan.overlay.half, minPx: plan.overlay.minPixels, color, sameGroup: true }) };
      this._ribbon(bucket("stairLine", { ...def, group: def.routeLine ?? def.group }), line.xy, line.z, overlay, pick, { offset: 0.03 });
    } else if (tunnel) {
      // Nawierzchnia w tunelu leży na posadzce tuby; widać ją przez wlot, a nad tunelem zasłania ją teren.
      this._ribbon(bucket(fillKind("ground"), { ...def, priority: this._drawPriority().get(feature.id) ?? 0 }), shape.xy, shape.z, fill, pick, { joins: shape.joins });
    } else if (elevated) {
      const walls = { bucket: bucket("solid", def), color: casingColor, thickness: this.deckThickness };
      // Obwódka pomostu nie może rysować kreski na jezdni dochodzącej do tego samego węzła.
      // Na pomoście kolejność daje głębia: trasa dochodząca leży minimalnie niżej od głównej.
      const deckOffset = Math.max(-MAX_DECK_LAYERS, this._drawPriority().get(feature.id) ?? 0) * DECK_LAYER_METERS;
      this._ribbon(bucket("raisedCasing", def), shape.xy, shape.z, casing, pick, { offset: deckOffset - DECK_CASING_DROP_METERS, joins: shape.joins, junctionCaps: false, walls }); // Obwódka zostaje pod każdą nawierzchnią, także przy wlocie trasy bocznej.
      this._ribbon(bucket(fillKind("raised"), def), shape.xy, shape.z, fill, pick, { offset: deckOffset, joins: shape.joins });
    } else if ((level?.lifted && level.units < 0) || interp.attributes.structure === "culvert") {
      this._ribbon(bucket("sunk", def), shape.xy, atSurface(shape.xy, shape.z), fill, pick, { offset: 0.1, joins: shape.joins });
    } else {
      if (def.casing) this._ribbon(bucket("casing", def), shape.xy, shape.z, casing, pick, { joins: shape.joins });
      this._ribbon(bucket(fillKind("ground"), { ...def, priority: this._drawPriority().get(feature.id) ?? 0 }), shape.xy, shape.z, fill, pick, { joins: shape.joins });
    }
    // Tunel z bryłą ma linię przebiegu na posadzce, jak każda trasa: widać ją we wnętrzu i przez wlot, a nad tunelem zasłania ją teren.
    const belowGround = !tunnel && ((level?.lifted && level.units < 0) || interp.attributes.structure === "culvert");
    // Połowa szerokości rysowanej nawierzchni w miejscu s, liczona tak samo jak w _strip (odcinek przejściowy, zwężenie przy styku z sąsiadem).
    const shapeLength = (() => { let l = 0; for (let i = 3; i < shape.xy.length; i += 3) l += Math.hypot(shape.xy[i] - shape.xy[i - 3], shape.xy[i + 1] - shape.xy[i - 2]); return l; })();
    // Przesunięcie początku nawierzchni względem początku osi: przycięcie (dodatnie) albo przedłużenie (ujemne) końca.
    const startCut = (() => {
      const axis = surfacePlan?.axis ?? points, along = surfacePlan?.along;
      if (!along || axis.length < 6) return 0;
      const x = shape.xy[0], y = shape.xy[1];
      let best = { d: Infinity, s: 0 };
      for (let i = 1; i < along.length; i += 1) {
        const ax = axis[i * 3 - 3], ay = axis[i * 3 - 2], dx = axis[i * 3] - ax, dy = axis[i * 3 + 1] - ay, l = Math.hypot(dx, dy) || 1;
        const u = ((x - ax) * dx + (y - ay) * dy) / l, tu = i === 1 ? Math.min(u, l) : Math.max(0, Math.min(l, u));
        const d = Math.hypot(x - ax - (dx / l) * tu, y - ay - (dy / l) * tu);
        if (d < best.d) best = { d, s: along[i - 1] + tu };
      }
      return best.s;
    })();
    const fillHalfAt = (s) => {
      if (transitionHalf) return transitionWidthAt(surfacePlan, s) / 2;
      const taper = Math.min(TAPER_METERS, shapeLength / 2) || 1, local = s - startCut;
      let h = half;
      for (const [join, d] of [[shape.joins?.start, local], [shape.joins?.end, shapeLength - local]]) {
        if (join?.type !== "continuation" || d >= taper) continue;
        const target = join.forkWidth !== undefined ? join.forkWidth / 2 : (half + neighbourFill(join.neighbour).half) / 2;
        h += (target - half) * (1 - d / taper);
      }
      return h;
    };
    if (surfacePlan?.surfaced && !plan && !belowGround) this._emitWayMarkings(surfacePlan, z, pick, bucket, elevated, fillHalfAt, Math.min(TAPER_METERS, shapeLength / 2));
    // Kolejność linii wynika z poziomu: linia wyżej leży nad linią niżej; tunel jest pod trasami na gruncie i ma jaśniejszy odcień.
    const underground = Boolean(tunnel) || belowGround;
    const lineRank = underground ? -1 : level?.lifted && level.units > 0 ? level.units : 0, tint = (hex) => (underground ? mixColor(rgb(hex), [1, 1, 1], TUNNEL_LINE_LIGHTEN) : rgb(hex));
    const lineKind = "line", lineDef = (extra) => ({ ...def, ...extra, priority: lineRank * LINE_RANK_STEP });
    const route = surfacePlan?.line;
    // Trasa pozostaje ciągła przez przejście, ale tam jest cienką nitką pod malowaniem.
    const through = surfacePlan?.lineZones?.length && !plan && !belowGround ? this._lineThroughCrossings(sourcePoints, z, surfacePlan.lineZones) : null;
    const linePoints = through?.xy ?? sourcePoints, lineZ = through?.z ?? z;
    if (route && !plan) {
      const lineStyle = (s) => { const other = this.model.surfaces?.byId.get(s.feature.id)?.line; return other ? { half: other.half, minPx: other.minPx, color: tint(other.color), sameGroup: other.group === route.group } : { half: route.half, minPx: route.minPx, color: tint(route.color), sameGroup: false }; };
      const style = { role: "mark", half: route.half, minPx: route.minPx, color: tint(route.color), neighbourStyle: lineStyle, narrowAt: through?.narrowAt };
      // Linie różnych klas nie przechodzą w siebie ostrym klinem; każda kończy się w węźle.
      const lineJoin = (join) => (join.type === "continuation" && this.model.surfaces.byId.get(join.neighbour.feature.id)?.line?.color !== route.color ? { type: "junction" } : join);
      const lineJoins = joins && { start: lineJoin(joins.start), end: lineJoin(joins.end) };
      // Linia przebiegu biegnie po geometrii OSM, nawet gdy placement przesuwa rysowaną jezdnię.
      this._ribbon(bucket(lineKind, lineDef({ group: route.group })), linePoints, lineZ, style, pick, { offset: 0.04, joins: surfacePlan.centerOffset ? null : lineJoins });
    }
    const mark = interp.attributes.routeMark ? this._routeColour(state) : null;
    if (mark && !plan) {
      // Kolor relacji jest wąskim środkiem linii przebiegu i jej nie zastępuje.
      const markHalf = (route?.half ?? half * 0.32) * 0.42;
      const style = { role: "mark", half: markHalf, minPx: 1, color: tint(mark), neighbourStyle: () => ({ half: markHalf, minPx: 1, color: tint(mark), sameGroup: true }) };
      this._ribbon(bucket(lineKind, lineDef({ group: route?.group ?? def.group, tier: Math.max(0, def.tier - 1) })), linePoints, through?.withoutZones ?? lineZ, style, pick, { offset: 0.045 });
    }
  }

  /** Czy punkt leży w obrysie budynku: przejście pod budynkiem jest przykryte budynkiem, a nie terenem. */
  /**
   * Wspólne indeksy rysowania (węzły, pokrycie nawierzchni, priorytety, budynki) liczone osobnymi etapami przed przebudową
   * kawałków przy doczytywaniu kafli; inaczej wszystkie powstawałyby w pierwszym kawałku i blokowały klatkę.
   */
  *warmSteps() {
    this._jointMap(); yield "węzły";
    this._coverIndex(); yield "pokrycie";
    this._drawPriority(); yield "priorytety";
    this._underBuilding(0, 0); yield "budynki";
    if (this.vegetation) { this.clearance ??= clearanceIndex(this.model, widthOf); yield "roślinność: trasy"; }
  }

  _underBuilding(x, y) {
    if (!this.buildingCells) {
      this.buildingCells = new Map();
      for (const state of this.model.states.values()) {
        if (state.interp.classDef.group !== "buildings" || state.interp.geometry !== "area" || state.feature.geometry === "point") continue;
        for (const rings of polygonsOf(state.feature)) {
          const outer = rings[0];
          if (!outer?.length) continue;
          const xs = outer.map((p) => p.x), ys = outer.map((p) => p.y);
          for (let i = Math.floor(Math.min(...xs) / BUILDING_CELL_METERS); i <= Math.floor(Math.max(...xs) / BUILDING_CELL_METERS); i += 1) {
            for (let j = Math.floor(Math.min(...ys) / BUILDING_CELL_METERS); j <= Math.floor(Math.max(...ys) / BUILDING_CELL_METERS); j += 1) {
              const key = `${i}:${j}`;
              if (!this.buildingCells.has(key)) this.buildingCells.set(key, []);
              this.buildingCells.get(key).push(rings);
            }
          }
        }
      }
    }
    const inside = (ring) => { let hit = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) hit = !hit; } return hit; };
    return (this.buildingCells.get(`${Math.floor(x / BUILDING_CELL_METERS)}:${Math.floor(y / BUILDING_CELL_METERS)}`) ?? []).some(([outer, ...holes]) => inside(outer) && !holes.some(inside));
  }

  /** Przekroje tunelu co metr wzdłuż osi; w wierzchołkach zachowują ścięcie, które łączy sąsiednie odcinki. */
  _tunnelStations(plan) {
    const out = [], { rows } = plan;
    rows.forEach((r, i) => {
      out.push(r);
      const c = rows[i + 1];
      if (!c) return;
      const l = Math.hypot(c.x - r.x, c.y - r.y) || 1, parts = Math.max(1, Math.ceil(l / TUNNEL_STEP_METERS)), dx = (c.x - r.x) / l, dy = (c.y - r.y) / l;
      for (let k = 1; k < parts; k += 1) {
        const f = k / parts;
        out.push({ s: r.s + l * f, x: r.x + (c.x - r.x) * f, y: r.y + (c.y - r.y) * f, z: r.z + (c.z - r.z) * f, tx: dx, ty: dy, nx: -dy, ny: dx, scale: 1 });
      }
    });
    return out;
  }

  /**
   * Tunel jak w budowie: tam, gdzie nad stropem leży grunt lub nasyp, jest zamknięta tuba; przy wlotach, gdzie terenu nad nim nie ma,
   * jest niecka z murami oporowymi sięgającymi terenu, a w miejscu przejścia stoi portal. Teren i bryły w obrysie tuby wycina shader.
   */
  _emitTunnel(state, plan, bucket, pick) {
    const def = state.interp.classDef, tube = bucket("tunnel", def), floorBucket = bucket("tunnelFloor", def);
    const inner = plan.width / 2, outer = inner + plan.wall, ceiling = plan.clearance, roof = ceiling + plan.slab, below = -plan.cutBelow;
    const colors = { inner: rgb(plan.colors.inner), floor: rgb(plan.colors.floor), outer: rgb(plan.colors.outer), portal: rgb(plan.colors.portal) };
    const at = (r, offset, dz) => [r.x + r.nx * r.scale * offset, r.y + r.ny * r.scale * offset, r.z + dz];
    const atZ = (r, offset, z) => [r.x + r.nx * r.scale * offset, r.y + r.ny * r.scale * offset, z];
    // Ściana, strop lub portal leżący we wnętrzu sąsiedniej tuby (dwa przejścia obok siebie) nie powstaje: wnętrza się łączą.
    const others = (this.model.tunnels?.cuts ?? []).filter((c) => !plan.cuts.includes(c));
    const insideOther = (corners) => {
      const x = corners.reduce((s, p) => s + p[0], 0) / 4, y = corners.reduce((s, p) => s + p[1], 0) / 4, z = corners.reduce((s, p) => s + p[2], 0) / 4;
      return others.some((c) => {
        const dx = c.bx - c.ax, dy = c.by - c.ay, t = ((x - c.ax) * dx + (y - c.ay) * dy) / (dx * dx + dy * dy || 1);
        if (t < 0 || t > 1 || Math.hypot(x - c.ax - dx * t, y - c.ay - dy * t) > c.half - 0.05) return false;
        const base = c.za + (c.zb - c.za) * t;
        return z > base && z < base + c.top;
      });
    };
    // Najniższa posadzka sąsiedniej tuby w punkcie; między posadzkami na różnych poziomach powstaje ściana schodka.
    const otherFloorAt = (x, y) => {
      let low = null;
      for (const c of others) {
        const dx = c.bx - c.ax, dy = c.by - c.ay, t = ((x - c.ax) * dx + (y - c.ay) * dy) / (dx * dx + dy * dy || 1);
        if (t < 0 || t > 1 || Math.hypot(x - c.ax - dx * t, y - c.ay - dy * t) > c.half - 0.05) continue;
        const z = c.za + (c.zb - c.za) * t + plan.cutBelow;
        if (low === null || z < low) low = z;
      }
      return low;
    };
    const quad = (b, corners, normal, col, ao) => {
      if (b === tube && others.length && insideOther(corners)) return;
      const start = b.count;
      corners.forEach((p, i) => this._solidVertex(b, p[0], p[1], p[2], normal, col, pick, ao[i]));
      b.index.push(start, start + 1, start + 2, start, start + 2, start + 3);
    };
    const groundAt = (x, y) => { const g = this.groundAt?.(x, y); return Number.isFinite(g) ? g : null; };
    const stations = this._tunnelStations(plan);
    for (const r of stations) {
      const g = groundAt(r.x, r.y);
      // Przykryciem jest grunt lub nasyp co najmniej 0,6 m nad stropem albo budynek nad przejściem.
      // Bez danych terenu zakładamy przykrycie: tuba nie znika, ale też nie powstaje niecka bez podstaw.
      r.covered = g === null || g >= r.z + roof + TUNNEL_COVER_METERS || this._underBuilding(r.x, r.y);
      r.side = [-1, 1].map((side) => { const p = at(r, side * outer, 0); return groundAt(p[0], p[1]) ?? r.z + roof; });
    }
    // Pojedynczy przekrój o innym stanie niż sąsiedzi wynika z nierówności NMT, nie z budowy obiektu.
    for (let i = 1; i < stations.length - 1; i += 1) if (stations[i - 1].covered === stations[i + 1].covered) stations[i].covered = stations[i - 1].covered;
    const view = { portals: [], covered: 0, open: 0 };
    for (let i = 1; i < stations.length; i += 1) {
      const a = stations[i - 1], c = stations[i], dx = c.x - a.x, dy = c.y - a.y, l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l;
      quad(floorBucket, [at(a, -inner, -0.03), at(c, -inner, -0.03), at(c, inner, -0.03), at(a, inner, -0.03)], [0, 0, 1], colors.floor, [0.7, 0.7, 0.7, 0.7]);
      for (const side of [-1, 1]) {
        if (!others.length) break;
        const pa = at(a, side * inner, 0), pc = at(c, side * inner, 0), fa = otherFloorAt(pa[0] + nx * side * 0.3, pa[1] + ny * side * 0.3), fc = otherFloorAt(pc[0] + nx * side * 0.3, pc[1] + ny * side * 0.3);
        if (fa !== null && fc !== null && fa < a.z - 0.05 && fc < c.z - 0.05) quad(floorBucket, [atZ(a, side * inner, fa), atZ(c, side * inner, fc), at(c, side * inner, -0.03), at(a, side * inner, -0.03)], [nx * side, ny * side, 0], colors.portal, [0.5, 0.5, 0.9, 0.9]);
      }
      if (a.covered && c.covered) {
        view.covered += l;
        if (!view.inside || Math.abs(i - stations.length / 2) < Math.abs(view.insideIndex - stations.length / 2)) { view.inside = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2, z: (a.z + c.z) / 2 }; view.insideIndex = i; }
        for (const side of [-1, 1]) {
          // Wnętrze jest ciemniejsze u dołu; zewnętrzna ściana sięga poniżej posadzki, aby przy terenie nie było szczeliny.
          quad(tube, [at(a, side * inner, -0.03), at(c, side * inner, -0.03), at(c, side * inner, ceiling), at(a, side * inner, ceiling)], [-nx * side, -ny * side, 0], colors.inner, [0.25, 0.25, 0.6, 0.6]);
          quad(tube, [at(a, side * outer, below), at(c, side * outer, below), at(c, side * outer, roof), at(a, side * outer, roof)], [nx * side, ny * side, 0], colors.outer, [0.6, 0.6, 1, 1]);
        }
        quad(tube, [at(a, -inner, ceiling), at(c, -inner, ceiling), at(c, inner, ceiling), at(a, inner, ceiling)], [0, 0, -1], colors.inner, [0.3, 0.3, 0.3, 0.3]);
        quad(tube, [at(a, -outer, roof), at(c, -outer, roof), at(c, outer, roof), at(a, outer, roof)], [0, 0, 1], colors.outer, [1, 1, 1, 1]);
        continue;
      }
      view.open += l;
      // Niecka: mur oporowy po każdej stronie sięga terenu z małym zapasem, ale nie wyżej niż strop tuby.
      [-1, 1].forEach((side, k) => {
        const top = (r) => Math.min(r.z + roof, Math.max(r.z, r.side[k]) + TUNNEL_COPING_METERS);
        const ta = top(a), tc = top(c);
        if (ta - a.z < TUNNEL_MIN_WALL_METERS && tc - c.z < TUNNEL_MIN_WALL_METERS) return;
        quad(tube, [at(a, side * inner, -0.03), at(c, side * inner, -0.03), atZ(c, side * inner, tc), atZ(a, side * inner, ta)], [-nx * side, -ny * side, 0], colors.outer, [0.35, 0.35, 0.9, 0.9]);
        quad(tube, [at(a, side * outer, below), at(c, side * outer, below), atZ(c, side * outer, tc), atZ(a, side * outer, ta)], [nx * side, ny * side, 0], colors.outer, [0.6, 0.6, 1, 1]);
        quad(tube, [atZ(a, side * inner, ta), atZ(c, side * inner, tc), atZ(c, side * outer, tc), atZ(a, side * outer, ta)], [0, 0, 1], colors.portal, [1, 1, 1, 1]);
      });
    }
    // Portal stoi tam, gdzie zamknięta tuba przechodzi w nieckę, oraz na końcu tuby, który nie łączy się z inną częścią tunelu.
    const portalAt = (r, sign) => {
      const normal = [r.tx * sign, r.ty * sign, 0];
      quad(tube, [at(r, -outer, ceiling), at(r, outer, ceiling), at(r, outer, roof), at(r, -outer, roof)], normal, colors.portal, [0.8, 0.8, 1, 1]);
      for (const side of [-1, 1]) quad(tube, [at(r, side * inner, below), at(r, side * outer, below), at(r, side * outer, ceiling), at(r, side * inner, ceiling)], normal, colors.portal, [0.6, 0.6, 0.9, 0.9]);
      view.portals.push({ x: r.x, y: r.y, z: r.z, dx: r.tx * sign, dy: r.ty * sign });
    };
    const last = stations.length - 1, segmentCovered = (i) => stations[i].covered && stations[i + 1].covered;
    if (last > 0 && plan.portals.start && segmentCovered(0)) portalAt(stations[0], -1);
    if (last > 0 && plan.portals.end && segmentCovered(last - 1)) portalAt(stations[last], 1);
    for (let i = 1; i < last; i += 1) {
      if (segmentCovered(i - 1) && !segmentCovered(i)) portalAt(stations[i], 1);
      else if (!segmentCovered(i - 1) && segmentCovered(i)) portalAt(stations[i], -1);
    }
    (this.tunnelViews ??= new Map()).set(plan.id, view);
  }

  _ground(points) {
    return Float32Array.from({ length: points.length / 3 }, (_, i) => points[i * 3 + 2] ?? NaN);
  }

  /** Bryła o płaskim lub dopasowanym wierzchu; `topAt` i `bottomAt` zwracają wysokość dla wierzchołka. */
  _prism(b, polygon, topAt, bottomAt, col, pick, step = 0) {
    const [outer, ...holes] = polygon;
    if (outer.length < 3) return;
    const faces = THREE.ShapeUtils.triangulateShape(outer, holes);
    const base = b.count;
    for (const p of [outer, ...holes].flat()) this._solidVertex(b, p.x, p.y, topAt(p), [0, 0, 1], col, pick, 1);
    for (const [i, j, k] of faces) b.index.push(base + i, base + j, base + k);
    for (const ring of [outer, ...holes]) {
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i], c = ring[(i + 1) % ring.length];
        const nx = c.y - a.y, ny = a.x - c.x, l = Math.hypot(nx, ny) || 1, normal = [nx / l, ny / l, 0], points = this._edgePoints(a, c, step);
        const bases = step > 0 ? this._wallBases(points, bottomAt) : points.map((p) => bottomAt(p));
        for (let k = 1; k < points.length; k += 1) {
          const p = points[k - 1], q = points[k], start = b.count;
          this._solidVertex(b, p.x, p.y, bases[k - 1], normal, col, pick, 0);
          this._solidVertex(b, q.x, q.y, bases[k], normal, col, pick, 0);
          this._solidVertex(b, q.x, q.y, topAt(q), normal, col, pick, 1);
          this._solidVertex(b, p.x, p.y, topAt(p), normal, col, pick, 1);
          b.index.push(start, start + 1, start + 2, start, start + 2, start + 3);
        }
      }
    }
  }

  _extrude(state, b, pick) {
    const { interp, feature } = state;
    const ground = groundOf(feature);
    if (ground === null) return;
    const { height, minHeight, roof } = interp.dimensions;
    let col = rgb(interp.classDef.color);
    if (height.approximate) col = col.map((v) => v + (1 - v) * 0.3);
    const top = ground + height.value, bottom = ground + minHeight.value;
    // Bryła od gruntu (min_height = 0): dół ścian w każdym punkcie na rysowanym terenie, nie na najniższym punkcie obrysu.
    // Bryła uniesiona (min_height > 0, np. część nad przejazdem) ma płaski spód.
    const bottomAt = minHeight.value > 0 ? () => bottom : (p) => this._wallBase(p.x, p.y, bottom, top);
    for (const polygon of polygonsOf(feature)) {
      if (!roof || roof.shape === "flat" || !this._roofed(b, polygon, state, ground, top, bottom, col, pick, bottomAt)) this._prism(b, polygon, () => top, bottomAt, col, pick, minHeight.value > 0 ? 0 : WALL_BASE_STEP_METERS);
    }
  }

  /** Dół ściany w punkcie: rysowany grunt (groundAt) tuż pod powierzchnią; bez danych terenu: najniższy punkt obrysu. */
  _wallBase(x, y, fallback, top) {
    const g = this.groundAt?.(x, y);
    return Number.isFinite(g) ? Math.min(g - WALL_BASE_SINK_METERS, top - 0.5) : fallback;
  }

  /**
   * Dół ściany w punktach łamanej: minimum gruntu w punkcie i w środkach sąsiednich odcinków, aby dół (liniowy między
   * punktami) nie wychodził nad grunt tam, gdzie teren między punktami jest wklęsły (np. dopasowanie pod drogą).
   */
  _wallBases(points, bottomAt) {
    const at = points.map((p) => bottomAt(p)), mids = [];
    for (let k = 1; k < points.length; k += 1) mids.push(bottomAt(new THREE.Vector2((points[k - 1].x + points[k].x) / 2, (points[k - 1].y + points[k].y) / 2)));
    return at.map((z, k) => Math.min(z, mids[k - 1] ?? Infinity, mids[k] ?? Infinity));
  }

  /** Punkty krawędzi p→q co `step` metrów (step = 0: same końce). */
  _edgePoints(p, q, step) {
    const n = step > 0 ? Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / step)) : 1, out = [];
    for (let k = 0; k <= n; k += 1) out.push(new THREE.Vector2(p.x + ((q.x - p.x) * k) / n, p.y + ((q.y - p.y) * k) / n));
    return out;
  }

  /**
   * Bryła z dachem (Key:roof:shape): ściany do okapu, a przy ścianach szczytowych do połaci; połacie w kolorze dachu.
   * height obejmuje dach, więc okap leży na height − wysokość dachu; bez tagu height (wysokość z kondygnacji) dach jest
   * dodany nad ścianami, chyba że wysokość wynika z roof:angle (wtedy znana dopiero tutaj). Zwraca false, gdy dachu nie da
   * się zbudować (np. wierzchołek dachu obrotowego poza mocno wklęsłym obrysem); wtedy bryła ma dach płaski.
   */
  _roofed(b, polygon, state, ground, top, bottom, col, pick, bottomAt = () => bottom) {
    const { roof, height } = state.interp.dimensions, cfg = this.model.profile.roofs;
    const known = roof.height.value !== null, tagged = height.source.startsWith("tag height");
    const wallTop = known || tagged ? top - (known ? roof.height.value : 0) : top;
    const spec = { shape: roof.shape, wallTop, height: known ? roof.height.value : null, angle: roof.angle, direction: roof.direction, orientation: roof.orientation, params: cfg.parameters };
    // Dach z roof:angle przy tagu height: okap obniżony o wysokość dachu wyliczoną z szerokości.
    let model = roofModel(polygon, spec);
    if (model && !known && tagged) model = roofModel(polygon, { ...spec, wallTop: top - model.height, height: model.height });
    if (!model) return false;
    // Dach wyższy niż bryła z tagów (okap poniżej spodu bryły + 0,5 m) albo bez połaci: bryła zostaje z dachem płaskim.
    const eave = known || tagged ? top - model.height : wallTop;
    if (model.faces.length === 0 || eave < bottom + 0.5) return false;
    // roof:colour: zapis szesnastkowy albo nazwa koloru CSS; nieznana wartość daje kolor domyślny dachu (przybliżenie).
    const value = roof.colour?.value?.trim(), valid = value && (/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value) || THREE.Color.NAMES[value.toLowerCase()] !== undefined);
    let roofCol = rgb(valid ? (/^[0-9a-f]{3,6}$/i.test(value) ? `#${value}` : value.toLowerCase()) : cfg.defaultColour);
    // Rozjaśnienie (prezentacja): bardzo ciemny dach z tagu, np. black, inaczej nie pokazuje cieniowania połaci.
    roofCol = roofCol.map((v) => v + (1 - v) * (!valid || roof.colour.approximate ? 0.15 : 0.12));
    for (const ring of polygon) {
      for (let i = 0; i < ring.length; i += 1) {
        const points = model.splitEdge(ring[i], ring[(i + 1) % ring.length]);
        const nx = ring[(i + 1) % ring.length].y - ring[i].y, ny = ring[i].x - ring[(i + 1) % ring.length].x, l = Math.hypot(nx, ny) || 1, normal = [nx / l, ny / l, 0];
        // Odcinki między załamaniami dachu dzielone co WALL_BASE_STEP_METERS: dół ściany biegnie po terenie.
        const dense = [points[0]];
        for (let k = 1; k < points.length; k += 1) dense.push(...this._edgePoints(points[k - 1], points[k], WALL_BASE_STEP_METERS).slice(1));
        const bases = this._wallBases(dense, bottomAt);
        for (let k = 1; k < dense.length; k += 1) {
          const p = dense[k - 1], q = dense[k], start = b.count;
          this._solidVertex(b, p.x, p.y, bases[k - 1], normal, col, pick, 0);
          this._solidVertex(b, q.x, q.y, bases[k], normal, col, pick, 0);
          this._solidVertex(b, q.x, q.y, model.top(q.x, q.y), normal, col, pick, 1);
          this._solidVertex(b, p.x, p.y, model.top(p.x, p.y), normal, col, pick, 1);
          b.index.push(start, start + 1, start + 2, start, start + 2, start + 3);
        }
      }
    }
    for (const face of model.faces) {
      const start = b.count;
      if (face.normal) for (const [x, y, z] of face.vertices) this._solidVertex(b, x, y, z, face.normal, roofCol, pick, 1);
      for (const [i, j, k] of face.triangles) {
        if (!face.normal) {
          // Dach obrotowy: normalna trójkąta (skierowana w górę) dla każdego trójkąta osobno.
          const v = face.vertices, [ax, ay, az] = v[i], [bx, by, bz] = v[j], [cx, cy, cz] = v[k];
          let n = [(by - ay) * (cz - az) - (bz - az) * (cy - ay), (bz - az) * (cx - ax) - (bx - ax) * (cz - az), (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)];
          if (n[2] < 0) n = n.map((c) => -c);
          const len = Math.hypot(...n) || 1, s = b.count;
          for (const idx of [i, j, k]) this._solidVertex(b, v[idx][0], v[idx][1], v[idx][2], n.map((c) => c / len), roofCol, pick, 1);
          b.index.push(s, s + 1, s + 2);
          continue;
        }
        b.index.push(start + i, start + j, start + k);
      }
    }
    return true;
  }

  /** Obrys mostu leży tuż pod pomostami i dojazdami na nim; ściany pomostów zakrywają różnicę wysokości. */
  /**
   * Płyta mostu z obrysu (man_made=bridge): wielokąty i wysokość wierzchu w punkcie. Wierzch leży tuż pod trasami tego
   * poziomu, a poza nimi na wysokości pomostów w pobliżu. Liczona raz i używana przez rysowanie płyty oraz bariery na niej.
   */
  _plate(state) {
    this.plates ??= new Map();
    if (this.plates.has(state.feature.id)) return this.plates.get(state.feature.id);
    const { feature, interp } = state;
    const polygons = polygonsOf(feature);
    const ground = groundOf(feature);
    if (ground === null) { this.plates.set(feature.id, null); return null; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of polygons.flat(2)) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const margin = 30, decks = new Map(), routes = new Map();
    const layer = interp.attributes.layer;
    const add = (cells, x, y, sample) => {
      const key = `${Math.floor(x / PLATE_CELL)}:${Math.floor(y / PLATE_CELL)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(sample);
    };
    // Próbki biegną wzdłuż całych odcinków: same węzły są zbyt rzadkie, by płyta ominęła jezdnię między nimi.
    // Trasy, których prostokąt sięga do 30 m od obrysu (dalsze próbki i tak są pomijane); lista tras liczona raz na pokolenie.
    if (!this.plateLines) {
      this.plateLines = [];
      for (const line of this.model.states.values()) {
        if (!isRibbonWay(line) || !line.interp.classDef.surfaced || line.interp.classDef.stairs || !line.level?.z) continue;
        this.plateLines.push({ line, box: boundsOf(line.feature) });
      }
    }
    for (const { line, box } of this.plateLines) {
      if (box[2] < minX - margin || box[0] > maxX + margin || box[3] < minY - margin || box[1] > maxY + margin) continue;
      const lifted = line.level.lifted && line.level.units > 0;
      if (lifted && layer !== undefined && line.interp.attributes.layer !== undefined && line.interp.attributes.layer !== layer) continue;
      const points = this.axisOf(line), half = widthOf(line) / 2;
      for (let i = 3; i < points.length; i += 3) {
        const ax = points[i - 3], ay = points[i - 2], bx = points[i], by = points[i + 1], za = line.level.z[i / 3 - 1], zb = line.level.z[i / 3];
        const parts = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / PLATE_SAMPLE_METERS));
        for (let k = 0; k <= parts; k += 1) {
          const t = k / parts, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
          if (x < minX - margin || x > maxX + margin || y < minY - margin || y > maxY + margin) continue;
          const sample = { x, y, z: za + (zb - za) * t, half };
          add(routes, x, y, sample);
          if (lifted) add(decks, x, y, sample);
        }
      }
    }
    const fallback = ground + this.model.profile.vertical.layerStepMeters;
    const deckLevel = (x, y) => {
      const cx = Math.floor(x / PLATE_CELL), cy = Math.floor(y / PLATE_CELL);
      for (let radius = 1; radius <= 8; radius += 1) {
        let total = 0, weight = 0;
        for (let i = cx - radius; i <= cx + radius; i += 1) for (let j = cy - radius; j <= cy + radius; j += 1) {
          for (const s of decks.get(`${i}:${j}`) ?? []) {
            const d2 = (s.x - x) ** 2 + (s.y - y) ** 2 + 0.25, w = 1 / (d2 * d2);
            total += w * s.z; weight += w;
          }
        }
        if (weight) return total / weight;
      }
      return fallback;
    };
    // Płyta leży pod każdą trasą tego poziomu, więc nigdy nie przykrywa jezdni; trasy biegnące niżej pod mostem się nie liczą.
    const heightAt = (x, y) => {
      const level = deckLevel(x, y), cx = Math.floor(x / PLATE_CELL), cy = Math.floor(y / PLATE_CELL);
      let lowest = level;
      for (let i = cx - 1; i <= cx + 1; i += 1) for (let j = cy - 1; j <= cy + 1; j += 1) {
        for (const s of routes.get(`${i}:${j}`) ?? []) {
          if (Math.abs(s.z - level) <= PLATE_LEVEL_RANGE_METERS && Math.hypot(s.x - x, s.y - y) <= s.half + PLATE_ROUTE_MARGIN_METERS) lowest = Math.min(lowest, s.z);
        }
      }
      return lowest - PLATE_BELOW_ROUTES_METERS;
    };
    // Pierścienie jako tablice [x, y, …] do testu punktu w obrysie (zewnętrzny bez otworów).
    const rings = polygons.map((polygon) => polygon.map((ring) => ring.flatMap((p) => [p.x, p.y])));
    // Punkt w obrysie albo do `reach` od jego krawędzi (bariera wzdłuż krawędzi mostu stoi na nim, a nie na przemian na płycie i obok).
    const nearEdge = (x, y, reach) => rings.some((polygon) => polygon.some((ring) => {
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const ax = ring[j], ay = ring[j + 1], dx = ring[i] - ax, dy = ring[i + 1] - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(x - ax - dx * t, y - ay - dy * t) <= reach) return true;
      }
      return false;
    }));
    const contains = (x, y, reach = 0) => x >= minX - reach && x <= maxX + reach && y >= minY - reach && y <= maxY + reach
      && (rings.some(([outer, ...holes]) => pointInRing(x, y, outer) && !holes.some((hole) => pointInRing(x, y, hole))) || (reach > 0 && nearEdge(x, y, reach)));
    const plate = { id: feature.id, layer, polygons, heightAt, contains };
    this.plates.set(feature.id, plate);
    return plate;
  }

  /** Płyty mostów, w których obrysie leży punkt (dla barier na konstrukcji). */
  _platesAt(x, y, layer) {
    if (!this.plateStates) {
      this.plateStates = [];
      for (const state of this.model.states.values()) if (state.interp.classDef.render === "structure" && state.interp.geometry === "area" && state.feature.geometry !== "point") this.plateStates.push(state);
    }
    const out = [];
    for (const state of this.plateStates) {
      const plateLayer = state.interp.attributes.layer;
      if (plateLayer !== undefined && layer !== undefined && plateLayer !== layer) continue;
      // Szybkie odrzucenie po prostokącie obrysu, zanim płyta zostanie policzona.
      const [x0, y0, x1, y1] = boundsOf(state.feature), reach = BARRIER_DECK_REACH_METERS;
      if (x < x0 - reach || x > x1 + reach || y < y0 - reach || y > y1 + reach) continue;
      const plate = this._plate(state);
      if (plate?.contains(x, y, BARRIER_DECK_REACH_METERS)) out.push(plate);
    }
    return out;
  }

  _structure(state, b, pick) {
    const { interp } = state, plate = this._plate(state);
    if (!plate) return;
    const { polygons, heightAt } = plate;
    const heights = new Map();
    const top = (p) => {
      const key = `${p.x.toFixed(3)}:${p.y.toFixed(3)}`;
      if (!heights.has(key)) heights.set(key, heightAt(p.x, p.y));
      return heights.get(key);
    };
    const densify = (ring) => ring.flatMap((p, i) => {
      const q = ring[(i + 1) % ring.length], parts = Math.ceil(p.distanceTo(q) / PLATE_EDGE_METERS);
      return Array.from({ length: parts }, (_, k) => p.clone().lerp(q, k / parts));
    });
    const col = rgb(interp.classDef.color);
    for (const polygon of polygons) {
      const rings = polygon.map(densify);
      const [outer, ...holes] = rings;
      if (outer.length < 3) continue;
      const all = rings.flat();
      const stack = THREE.ShapeUtils.triangulateShape(outer, holes).map((f) => f.map((i) => all[i]));
      // Płyta ma gęste wierzchołki, aby między nimi żadna trasa nie znalazła się pod jej powierzchnią.
      while (stack.length) {
        const t = stack.pop();
        let longest = -1, length = PLATE_EDGE_METERS;
        for (let i = 0; i < 3; i += 1) {
          const d = t[i].distanceTo(t[(i + 1) % 3]);
          if (d > length) { length = d; longest = i; }
        }
        if (longest >= 0) {
          const a = t[longest], c = t[(longest + 1) % 3], d = t[(longest + 2) % 3], middle = a.clone().lerp(c, 0.5);
          stack.push([a, middle, d], [middle, c, d]);
          continue;
        }
        const base = b.count;
        for (const p of t) this._solidVertex(b, p.x, p.y, top(p), [0, 0, 1], col, pick, 1);
        b.index.push(base, base + 1, base + 2);
      }
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i += 1) {
          const p = ring[i], q = ring[(i + 1) % ring.length];
          const nx = q.y - p.y, ny = p.x - q.x, l = Math.hypot(nx, ny) || 1, normal = [nx / l, ny / l, 0], start = b.count;
          this._solidVertex(b, p.x, p.y, top(p) - this.deckThickness, normal, col, pick, 0);
          this._solidVertex(b, q.x, q.y, top(q) - this.deckThickness, normal, col, pick, 0);
          this._solidVertex(b, q.x, q.y, top(q), normal, col, pick, 1);
          this._solidVertex(b, p.x, p.y, top(p), normal, col, pick, 1);
          b.index.push(start, start + 1, start + 2, start, start + 2, start + 3);
        }
      }
    }
  }

  setGroupVisible(group, visible) {
    if (visible) this.hiddenGroups.delete(group); else this.hiddenGroups.add(group);
  }

  drawnAtDistance(tier, distance) { return distance < TIER_RANGE[tier] * this.detail; }

  /** Kawałek jest tylko wstępnie odrzucany; granicę szczegółowości wyznacza odległość każdego fragmentu. */
  updateLod(cameraPosition) {
    let draw = 0;
    const centre = new THREE.Vector3();
    for (const chunk of this.chunks.values()) {
      for (const mesh of chunk.meshes) {
        const { tier, group } = mesh.userData;
        const sphere = mesh.geometry.boundingSphere;
        const near = centre.copy(sphere.center).distanceTo(cameraPosition) - sphere.radius;
        mesh.visible = !this._groupHidden(group) && near < (mesh.userData.reach ?? TIER_RANGE[tier]) * this.detail;
        if (mesh.visible) draw += 1;
      }
    }
    return draw;
  }
}
