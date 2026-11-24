// Model sceny: dane źródłowe (niezmienne) + nakładka sesji → interpretacja → poziomy → diagnostyka.
import { buildSpatialIndexSteps, evaluateDiagnostics, finishSteps } from "./diagnostics.js";
import { compileProfile, interpret } from "./interpreter.js";
import { computeLevelsSteps, levelSignature } from "./levels.js";
import { EditSession } from "./session.js";
import { planAllBarriers } from "./barriers.js";
import { planAllStairs } from "./steps.js";
import { planAllSurfaces, planAllSurfacesSteps } from "./surfaces.js";
import { planAllTunnels } from "./tunnels.js";
import { inferSupports } from "./supports.js";
import { planBuildingParts } from "./buildings.js";

const PRINT_SCOPE_METERS = 300, PRINT_SCOPE_LIMIT = 200;
// Liczba obiektów interpretowanych w jednym etapie doczytywania (między przerwami na klatkę).
const INTERPRET_BATCH = 4000;
// Liczba obiektów, których odcisk jest liczony w jednym etapie doczytywania.
const PRINT_BATCH = 15000;

/** Prostokąt obejmujący obiekt [minX, minY, maxX, maxY], liczony raz (położenie obiektu w poziomie się nie zmienia). */
const BOUNDS = new WeakMap();
export function boundsOf(feature) {
  if (BOUNDS.has(feature)) return BOUNDS.get(feature);
  const p = feature.points ?? feature.point ?? feature.anchor;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
  const box = x0 <= x1 ? [x0, y0, x1, y1] : [0, 0, 0, 0];
  BOUNDS.set(feature, box);
  return box;
}

function freeze(feature) {
  Object.freeze(feature.tags);
  return feature;
}

export class SceneModel {
  constructor(manifest, profile) {
    this.manifest = manifest;
    this.profile = profile;
    this.compiled = compileProfile(profile);
    this.session = new EditSession();
    this.states = new Map();
    this.relations = new Map();
    this.index = null;
    this.diagnostics = { issues: [], stats: {} };
    this.byOsm = new Map();
  }

  /**
   * Dodaje obiekty (np. z kafli danych). Obiekt już obecny (ten sam identyfikator z sąsiedniego kafla) nie jest dublowany;
   * jego brakujące wysokości uzupełniają się z nowej kopii. Zmiany sesyjne obowiązują także dla obiektów wczytanych później.
   */
  addFeatures(features, relations, options = {}) {
    const steps = this._addSteps(features, relations, options);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  /**
   * To samo co addFeatures, ale etapami z przerwą na klatkę między nimi (`pause`): przeliczenie kilkudziesięciu tysięcy
   * obiektów nie blokuje obrazu na kilka sekund. W trakcie (`busy`) model jest niespójny: edycja i inspektor czekają.
   */
  async addFeaturesStaged(features, relations, options = {}, pause = () => new Promise((resolve) => setTimeout(resolve, 0))) {
    this.busy = true;
    this.stageTimings = {};
    try {
      const steps = this._addSteps(features, relations, options);
      let started = performance.now(), step = steps.next();
      // Czas pracy każdego etapu (ms, najdłuższy przy powtórzeniach) do kontroli płynności.
      const note = () => { if (!step.done) this.stageTimings[step.value] = Math.max(this.stageTimings[step.value] ?? 0, Math.round(performance.now() - started)); };
      note();
      while (!step.done) { await pause(); started = performance.now(); step = steps.next(); note(); }
      this.stageTimings.odciski = Math.round(performance.now() - started);
      return step.value;
    } finally {
      this.busy = false;
    }
  }

  /** Etapy dodawania obiektów; yield oddziela etapy, po których można oddać klatkę. */
  *_addSteps(features, relations, { remove = [] } = {}) {
    // Pokolenie modelu: renderer wie, że jego indeksy (węzły, pokrycie, budynki) dotyczą starego zestawu obiektów.
    this.generation = (this.generation ?? 0) + 1;
    for (const id of remove) {
      const state = this.states.get(id);
      if (!state) continue;
      this.states.delete(id);
      this.byOsm.delete(`${state.feature.osmType}/${state.feature.osmId}`);
    }
    for (const relation of Object.values(relations)) this.relations.set(relation.id, relation);
    for (let n = 0; n < features.length; n += 1) {
      if (n && n % INTERPRET_BATCH === 0) yield "interpretacja";
      const feature = features[n], existing = this.states.get(feature.id);
      if (existing) { fillMissingHeights(existing.feature, feature); continue; }
      freeze(feature);
      const tags = this.session.effectiveTags(feature.id, feature.tags);
      const state = { feature, tagsNow: tags, interp: null, level: null, signature: "" };
      state.interp = interpret(feature, tags, this.compiled);
      state.signature = levelSignature(state.interp);
      this.states.set(feature.id, state);
      this.byOsm.set(`${feature.osmType}/${feature.osmId}`, feature.id);
    }
    yield "interpretacja";
    this.index = yield* buildSpatialIndexSteps([...this.states.values()].map((s) => s.feature));
    yield "indeks";
    yield* this._recomputeLevelsSteps();
    yield "poziomy";
    this.surfaces = yield* planAllSurfacesSteps(this);
    yield "nawierzchnie";
    this.stairs = planAllStairs(this);
    this.barriers = planAllBarriers(this);
    yield "schody i bariery";
    this.tunnels = planAllTunnels(this);
    yield "tunele";
    this.supports = inferSupports(this);
    yield "podpory";
    this.buildingParts = planBuildingParts(this);
    yield "części budynków";
    this._recomputeDiagnostics();
    yield "diagnostyka";
    return { changed: yield* this._updatePrintsSteps() };
  }

  /**
   * Odcisk danych, z których widok rysuje obiekt (poziom i plany: nawierzchnia, przejście, bariera, tunel, schody).
   * Po doczytaniu kafli przebudowywane są tylko obiekty, których odcisk się zmienił, oraz otoczenie zmienionych kafli.
   * Zwraca identyfikatory obiektów nowych albo ze zmienionym odciskiem; scope ogranicza porównanie do prostokątów.
   */
  _updatePrints(scope = null) { return finishSteps(this._updatePrintsSteps(scope)); }

  *_updatePrintsSteps(scope = null) {
    const previous = this.prints ?? new Map(), prints = scope ? previous : new Map(), changed = new Set();
    const replacer = (key, value) => (value instanceof Set || value instanceof Map ? [...value] : ArrayBuffer.isView(value) ? Array.from(value) : value);
    let count = 0;
    for (const state of this.states.values()) {
      if ((count += 1) % PRINT_BATCH === 0) yield "odciski";
      const id = state.feature.id;
      if (scope) { const b = boundsOf(state.feature); if (!scope.some((r) => b[0] <= r[2] && b[2] >= r[0] && b[1] <= r[3] && b[3] >= r[1])) continue; }
      const text = JSON.stringify([state.level, this.surfaces?.byId.get(id), this.surfaces?.crossings.get(id), this.barriers?.byId.get(id), this.tunnels?.byId.get(id), this.stairs?.byId.get(id), this.buildingParts?.hidden.has(id) ?? false], replacer);
      const print = fingerprint(text);
      prints.set(id, print);
      if (previous.get(id) !== print) changed.add(id);
    }
    this.prints = prints;
    return changed;
  }

  _lineItems() {
    return [...this.states.values()].filter((s) => s.feature.geometry === "way")
      .map((s) => ({ feature: s.feature, interp: s.interp }));
  }

  _recomputeLevels() { return finishSteps(this._recomputeLevelsSteps()); }

  *_recomputeLevelsSteps() {
    const levels = yield* computeLevelsSteps(this._lineItems(), this.profile.vertical, this.index?.crossings ?? []);
    const changed = new Set();
    for (const state of this.states.values()) {
      const next = levels.get(state.feature.id) ?? null;
      if (!sameZ(state.level, next)) changed.add(state.feature.id);
      state.level = next;
    }
    return changed;
  }

  _recomputeDiagnostics() {
    this.diagnostics = evaluateDiagnostics(this.states, this.index);
    this.diagnostics.issues.push(...(this.supports?.issues ?? []), ...(this.stairs?.issues ?? []), ...(this.surfaces?.issues ?? []), ...(this.barriers?.issues ?? []), ...(this.tunnels?.issues ?? []), ...(this.buildingParts?.issues ?? []));
  }

  sourceTags(id) { return this.states.get(id).feature.tags; }

  /** Po zmianie tagów przelicza zależności i zwraca obiekty wymagające przebudowy widoku. */
  refresh(ids) {
    const started = performance.now();
    const changed = new Set();
    let levelsDirty = false;
    for (const id of ids) {
      const state = this.states.get(id);
      state.tagsNow = this.session.effectiveTags(id, state.feature.tags);
      state.interp = interpret(state.feature, state.tagsNow, this.compiled);
      const signature = levelSignature(state.interp);
      if (signature !== state.signature) { state.signature = signature; levelsDirty = true; }
      changed.add(id);
    }
    const levelChanged = levelsDirty ? this._recomputeLevels() : new Set();
    for (const id of levelChanged) changed.add(id);
    this.surfaces = planAllSurfaces(this);
    this.stairs = planAllStairs(this);
    this.barriers = planAllBarriers(this);
    this.tunnels = planAllTunnels(this);
    this.supports = inferSupports(this);
    this.buildingParts = planBuildingParts(this);
    this._recomputeDiagnostics();
    // Zmiana tagu może zmienić plan sąsiada (przejście, rozwidlenie, linia krawędziowa): on także trafia do przebudowy.
    // Takie zależności są lokalne, więc odciski są porównywane w promieniu PRINT_SCOPE_METERS od edytowanych obiektów.
    // Obejmuje też trasy ze zmienionym poziomem (poziom wpływa np. na linie krawędziowe sąsiadów); przy wielu takich trasach całość.
    const around = [...ids, ...levelChanged];
    const scope = around.length > PRINT_SCOPE_LIMIT ? null : around.map((id) => boundsOf(this.states.get(id).feature)).map(([x0, y0, x1, y1]) => [x0 - PRINT_SCOPE_METERS, y0 - PRINT_SCOPE_METERS, x1 + PRINT_SCOPE_METERS, y1 + PRINT_SCOPE_METERS]);
    for (const id of this._updatePrints(scope)) changed.add(id);
    return { changed, milliseconds: performance.now() - started };
  }

  edit(action) {
    const touched = action(this.session, (id) => this.sourceTags(id));
    const ids = (Array.isArray(touched) ? touched : [touched]).filter(Boolean);
    return ids.length ? { ...this.refresh(ids), ids } : null;
  }

  issuesFor(id) { return this.diagnostics.issues.filter((issue) => issue.objects.includes(id)); }
}

/** Skrót tekstu: długość i FNV-1a (32 bity); kolizja przy porównaniu jednego obiektu z jego poprzednią wersją jest pomijalnie mało prawdopodobna. */
function fingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${text.length}:${h >>> 0}`;
}

/** Kopia obiektu z sąsiedniego kafla ma wysokości NMT tam, gdzie pierwszy kafel ich nie miał (poza swoim terenem). */
function fillMissingHeights(target, source) {
  if (!target.points || !source.points || target.points.length !== source.points.length) return;
  for (let i = 2; i < target.points.length; i += 3) if (target.points[i] === null && source.points[i] !== null) target.points[i] = source.points[i];
}

function sameZ(a, b) {
  if (!a || !b) return a === b;
  if (a.z.length !== b.z.length) return false;
  for (let i = 0; i < a.z.length; i += 1) if (Math.abs(a.z[i] - b.z[i]) > 0.005) return false;
  return true;
}
