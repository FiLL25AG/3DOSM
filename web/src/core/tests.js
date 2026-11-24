// Testy czystej logiki, uruchamiane w przeglądarce pod /tests.html na prawdziwym profilu.
import { FeatureRenderer, LAYER_ORDER } from "../render/features.js";
import { auditBridgePlates, auditHangingWalls, geometryAudit, sectionGeometry, surfaceZ } from "../render/networkAudit.js";
import { GroundConform } from "../render/groundConform.js";
import { roofModel } from "../render/roofs.js";
import { TerrainSystem } from "../render/terrain.js";
import { clearanceIndex, gridInside, plantsOf } from "../render/vegetation.js";
import { catenary, directionsOf, drawPitch, pitchFrame, powerIndex, trackLanes } from "../render/furniture.js";
import * as THREE from "three";
import { sharedUniforms } from "../render/shaders.js";
import { auditContinuity } from "./audit.js";
import { wgs84ToPl1992 } from "./crs.js";
import { physicalStatus } from "./diagnostics.js";
import { SceneModel } from "./model.js";
import { compileProfile, interpret } from "./interpreter.js";
import { EditSession } from "./session.js";
import { laneOffset } from "./surfaces.js";
import { parseConnectivity } from "./connectivity.js";

const results = [];
const test = (name, fn) => { try { fn(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: error.message }); } };
const eq = (a, b, label = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} oczekiwano ${JSON.stringify(b)}, jest ${JSON.stringify(a)}`); };
const ok = (value, label) => { if (!value) throw new Error(label); };

let nextNode = 1;
function way(id, coordinates, tags, nodeRefs) {
  const points = coordinates.flatMap(([x, y, z = 80]) => [x, y, z]);
  const refs = nodeRefs ?? coordinates.map(() => nextNode++);
  return { id: `w${id}`, osmType: "way", osmId: id, geometry: "way", closed: refs[0] === refs[refs.length - 1] && refs.length > 3, tags, meta: {}, relations: [], points, nodeRefs: refs, nodeIndex: refs.map((_, i) => i) };
}
const point = (id, x, y, tags) => ({ id: `n${id}`, osmType: "node", osmId: id, geometry: "point", tags, meta: {}, relations: [], point: [x, y, 80] });
const manifest = { crs: {}, sources: [] };

function scene(profile, features, relations = {}) {
  const model = new SceneModel(manifest, profile);
  model.addFeatures(features, relations);
  return model;
}
const physical = (model) => model.diagnostics.issues.filter((i) => i.category === "physical");

async function main() {
  const profile = await (await fetch("/api/profile")).json();
  const compiled = compileProfile(profile);
  const line = (tags, relations = []) => interpret({ geometry: "way", closed: false, relations }, tags, compiled);

  test("EPSG:2180 w kliencie zgadza się z PROJ (< 1 cm)", () => {
    const [e, n] = wgs84ToPl1992(21.0975, 52.2138);
    ok(Math.abs(e - 643256.5654730507) < 0.01 && Math.abs(n - 485154.6800434347) < 0.01, `${e}, ${n}`);
  });
  test("klasa pochodzi z reguły i jest prześledzona", () => {
    const result = line({ highway: "primary", bridge: "yes", layer: "1" });
    eq(result.classId, "road.primary");
    ok(result.trace.some((r) => r.ruleId === "pl.road.primary"), "brak reguły klasy");
    ok(result.trace.some((r) => r.ruleId === "pl.attr.bridge"), "brak reguły mostu");
    eq(result.attributes.layer, 1);
  });
  test("ciąg pieszo-rowerowy wynika z tagów dostępu", () => eq(line({ highway: "path", foot: "designated", bicycle: "designated" }).classId, "cycle.shared"));
  test("kolor nie zmienia klasyfikacji drogi rowerowej", () => eq(line({ highway: "cycleway", colour: "red" }).classId, line({ highway: "cycleway" }).classId));
  test("nieznany tag nie jest zgadywany", () => { const r = line({ "x:foo": "bar" }); eq(r.classId, "unknown"); ok(r.uncertainties.some((u) => u.code === "no-rule"), "brak niepewności"); });
  test("sprzeczne reguły pozostawiają obiekt nierozpoznany", () => { const r = line({ highway: "primary", railway: "rail" }); eq(r.classId, "unknown"); ok(r.uncertainties.some((u) => u.code === "rule-conflict"), "brak konfliktu"); });
  test("błędna wartość daje ostrzeżenie i nie blokuje", () => { const r = line({ highway: "primary", layer: "wysoko" }); eq(r.attributes.layer, undefined); ok(r.warnings.some((w) => w.key === "layer"), "brak ostrzeżenia"); eq(r.classId, "road.primary"); });
  test("nierozpoznana wartość highway daje ostrzeżenie", () => ok(line({ highway: "autobahnn" }).warnings.some((w) => w.key === "highway"), "brak ostrzeżenia"));
  test("man_made=pier nie jest podporą mostu", () => eq(interpret({ geometry: "way", closed: true, relations: [] }, { man_made: "pier", area: "yes" }, compiled).classId, "structure.pier"));
  test("name:pl ma pierwszeństwo przed name", () => eq(line({ highway: "primary", name: "A", "name:pl": "B" }).name, "B"));

  test("sesja: dodanie, zmiana, usunięcie, cofnięcie i przywrócenie", () => {
    const source = Object.freeze({ a: "1", b: "2" });
    const s = new EditSession();
    s.setTag("f", source, "c", "3"); s.setTag("f", source, "a", "9"); s.deleteTag("f", source, "b");
    eq(s.effectiveTags("f", source), { a: "9", c: "3" });
    eq(s.diff("f", source).map((d) => d.status), ["zmieniony", "usunięty", "dodany"]);
    s.undo(() => source); s.undo(() => source); s.undo(() => source);
    eq(s.effectiveTags("f", source), source); eq(s.hasChanges, false);
    s.redo(() => source); eq(s.effectiveTags("f", source).c, "3");
    s.restoreFeature("f", source); eq(s.hasChanges, false); eq(source, { a: "1", b: "2" });
  });
  test("sesja: zmiana klucza to jeden krok cofania", () => {
    const source = { a: "1" }; const s = new EditSession();
    s.renameTag("f", source, "a", "z"); eq(s.effectiveTags("f", source), { z: "1" });
    s.undo(() => source); eq(s.effectiveTags("f", source), source);
  });

  const road = (id, c, tags, refs) => way(id, c, { highway: "secondary", ...tags }, refs);
  test("wiadukt nad drogą nie jest kolizją", () => {
    const m = scene(profile, [road(1, [[-50, 0], [50, 0]], { bridge: "yes", layer: "1" }), road(2, [[0, -50], [0, 50]], {})]);
    eq(physical(m).length, 0); eq(m.diagnostics.stats.separatedByTags, 1);
  });
  test("most nad rzeką nie jest kolizją, droga bez mostu jest podejrzeniem", () => {
    const water = () => way(2, [[0, -50], [0, 50]], { waterway: "river" });
    eq(physical(scene(profile, [road(1, [[-50, 0], [50, 0]], { bridge: "yes", layer: "1" }), water()])).length, 0);
    const issues = physical(scene(profile, [road(1, [[-50, 0], [50, 0]], {}), water()]));
    eq(issues.length, 1); eq(issues[0].status, "podejrzenie");
  });
  test("przecięcie na jednym poziomie jest tylko podejrzeniem i wskazuje oba obiekty", () => {
    const [issue] = physical(scene(profile, [road(1, [[-50, 0], [50, 0]], {}), road(2, [[0, -50], [0, 50]], {})]));
    eq(issue.status, "podejrzenie"); eq(issue.objects.sort(), ["w1", "w2"]); eq(issue.levels.length, 2);
  });
  test("połączenie wspólnym węzłem nie jest kolizją", () => {
    eq(physical(scene(profile, [road(1, [[-50, 0], [0, 0], [50, 0]], {}, [1001, 1002, 1003]), road(2, [[0, -50], [0, 0], [0, 50]], {}, [1004, 1002, 1005])])).length, 0);
  });
  test("potwierdzenie wymaga wiarygodnych poziomów obu obiektów", () => {
    eq(physicalStatus({ reliable: false, zAtCrossing: 1 }, { reliable: true, zAtCrossing: 1 }), "podejrzenie");
    eq(physicalStatus({ reliable: true, zAtCrossing: 1 }, { reliable: true, zAtCrossing: 1.5 }), "potwierdzona");
    eq(physicalStatus({ reliable: true, zAtCrossing: 1 }, { reliable: true, zAtCrossing: 9 }), "rozdzielone");
  });
  test("edycja layer od razu zmienia diagnostykę i można ją cofnąć", () => {
    const m = scene(profile, [road(1, [[-50, 0], [50, 0]], {}), road(2, [[0, -50], [0, 50]], {})]);
    eq(physical(m).length, 1);
    m.edit((s, src) => (s.setTag("w1", src("w1"), "layer", "1") ? "w1" : null)); eq(physical(m).length, 0);
    m.edit((s, src) => s.undo(src)); eq(physical(m).length, 1);
  });
  test("edycja mostu podnosi obiekt w modelu i nie zmienia danych źródłowych", () => {
    const m = scene(profile, [road(1, [[0, 0], [200, 0], [400, 0]], {})]);
    eq(m.states.get("w1").level.lifted, false);
    const { changed } = m.edit((s, src) => (s.setTag("w1", src("w1"), "bridge", "yes") ? "w1" : null));
    ok(changed.has("w1"), "brak przebudowy"); ok(m.states.get("w1").level.z[1] > 84, "brak uniesienia");
    eq(m.states.get("w1").feature.tags.bridge, undefined);
  });
  test("sam tag layer nie podnosi drogi ponad NMT", () => {
    const m = scene(profile, [road(1, [[0, 0], [100, 0], [200, 0]], { layer: "2" })]);
    eq(m.states.get("w1").level.lifted, false); eq(Array.from(m.states.get("w1").level.z), [80, 80, 80]);
  });
  test("wspólny węzeł ma jedną wysokość także przy różnych layer", () => {
    const m = scene(profile, [
      road(1, [[0, 0], [300, 0], [600, 0]], { bridge: "yes", layer: "1" }, [1, 2, 3]),
      road(2, [[600, 0], [900, 0], [1200, 0]], { bridge: "yes", layer: "2" }, [3, 4, 5]),
      road(3, [[1200, 0], [1400, 0]], {}, [5, 6]),
    ]);
    eq(auditContinuity(m).heightJumps.count, 0);
  });
  test("wiadukt nad drogą ma wymagany prześwit, także blisko przyczółka", () => {
    const m = scene(profile, [road(1, [[-300, 0], [-20, 0], [20, 0], [300, 0]], { bridge: "yes", layer: "1" }), road(2, [[0, -100], [0, 100]], {})]);
    ok(auditContinuity(m).separation.worst[0].gap >= 5.4, "za mały prześwit");
  });
  test("zagłębienie NMT pod końcem mostu nie tworzy skoku drogi", () => {
    const dip = [[0, 0, 90], [15, 0, 90], [30, 0, 70], [45, 0, 90], [60, 0, 90]];
    const m = scene(profile, [road(1, dip, {})]);
    const a = auditContinuity(m, { maxGrade: 0.101 });
    eq(a.steepSegments.count, 0);
  });
  test("droga dochodząca do środka pomostu wznosi się do jego wysokości", () => {
    const m = scene(profile, [
      road(1, [[0, 0], [200, 0], [400, 0]], { bridge: "yes", layer: "1" }, [1, 2, 3]),
      road(2, [[200, 0], [200, 200]], {}, [2, 4]),
    ]);
    eq(auditContinuity(m).heightJumps.count, 0);
    ok(m.states.get("w1").level.z[1] > 84, "pomost opadł do terenu");
  });
  test("koniec jezdni tuż przy innej jezdni jest raportowany bez zmiany geometrii", () => {
    const before = [[0, 0], [100, 0]];
    const m = scene(profile, [road(1, before, {}), road(2, [[101, -50], [101, 50]], {})]);
    ok(m.diagnostics.issues.some((i) => i.code === "topology-gap"), "brak raportu");
    eq(m.states.get("w1").feature.points.slice(3, 5), [100, 0]);
  });
  const joints = (features) => {
    const model = scene(profile, features);
    return { model, audit: geometryAudit({ model, features: new FeatureRenderer(model, sharedUniforms()) }) };
  };
  test("kontynuacja ma wspólne krawędzie także przy zmianie szerokości i klasy", () => {
    const { audit } = joints([
      way(1, [[0, 0], [50, 0], [100, 4]], { highway: "primary" }, [1, 2, 3]),
      way(2, [[100, 4], [150, 12], [200, 20]], { highway: "primary_link" }, [3, 4, 5]),
    ]);
    eq(audit.continuations, 1); eq(audit.edgeSteps, 0); eq(audit.widthSteps, 0); eq(audit.withGap, 0); eq(audit.withProtrusion, 0);
  });
  test("skrzyżowanie jest domknięte i nie ma wystających narożników", () => {
    const { audit } = joints([
      way(1, [[-60, 0], [0, 0], [60, 0]], { highway: "secondary" }, [1, 2, 3]),
      way(2, [[0, 0], [0, 60]], { highway: "residential" }, [2, 4]),
      way(3, [[0, 0], [-40, -40]], { highway: "cycleway" }, [2, 5]),
    ]);
    eq(audit.joints, 1); eq(audit.withGap, 0); eq(audit.withProtrusion, 0);
  });
  test("ostry zakręt między trasami nie zostawia szczeliny", () => {
    const { audit } = joints([way(1, [[0, 0], [60, 0]], { highway: "secondary" }, [1, 2]), way(2, [[60, 0], [20, 40]], { highway: "secondary" }, [2, 3])]);
    eq(audit.withGap, 0);
  });
  test("trasy blisko siebie bez wspólnego węzła nie są łączone", () => {
    const { model, audit } = joints([way(1, [[0, 0], [50, 0]], { highway: "residential" }, [1, 2]), way(2, [[50.2, 0], [100, 0]], { highway: "residential" }, [3, 4])]);
    eq(audit.joints, 0);
    ok(model.diagnostics.issues.some((i) => i.code === "coincident-nodes"), "brak raportu o węzłach");
  });
  test("sąsiednie jezdnie tej samej rangi tworzą równą nawierzchnię", () => {
    const flat = (y, id, refs, tags = {}) => way(id, [[0, y], [50, y], [100, y], [150, y], [200, y]], { highway: "primary", oneway: "yes", ...tags }, refs);
    const ramp = way(9, [[-120, 0], [0, 0]], { highway: "primary" }, [9, 1]);
    const deck = way(8, [[-300, 0], [-120, 0]], { highway: "primary", bridge: "yes", layer: "1" }, [8, 9]);
    const under = way(7, [[-200, -60], [-200, 60]], { highway: "secondary" }, [70, 71]);
    const model = scene(profile, [deck, under, ramp, flat(0, 1, [1, 2, 3, 4, 5]), flat(11, 2, [11, 12, 13, 14, 15])]);
    const a = model.states.get("w1").level.z, b = model.states.get("w2").level.z;
    ok(Math.abs(a[1] - b[1]) < 0.3, `różnica ${Math.abs(a[1] - b[1])}`);
    eq(auditContinuity(model).heightJumps.count, 0);
  });
  test("ścieżka obok podniesionej jezdni nie jest podnoszona razem z nią", () => {
    const road = way(1, [[0, 0], [100, 0], [200, 0]], { highway: "primary", bridge: "yes", layer: "1" }, [1, 2, 3]);
    const path = way(2, [[0, 7], [100, 7], [200, 7]], { highway: "footway", bridge: "no" }, [4, 5, 6]);
    const model = scene(profile, [road, path]);
    eq(Array.from(model.states.get("w2").level.z), [80, 80, 80]);
  });
  const stair = (tags = {}, heights = [80, 82]) => {
    const coordinates = [[0, 0, heights[0]], [5, 0, (heights[0] + heights[1]) / 2], [10, 0, heights[1]]];
    return scene(profile, [way(1, coordinates, { highway: "steps", ...tags }, [1, 2, 3])]);
  };
  const planOf = (model) => model.stairs.byId.get("w1");
  test("schody z tagami mają stopnie z danych i kończą się na węzłach", () => {
    const model = stair({ step_count: "10", surface: "wood", incline: "up", width: "3" }), plan = planOf(model), z = model.states.get("w1").level.z;
    eq(plan.count, 10); eq(plan.provenance.count.approximate, false); eq(plan.materialId, "wood"); eq(plan.width, 3);
    ok(Math.abs(plan.riser - (z[z.length - 1] - z[0]) / 10) < 1e-6, "zła wysokość"); ok(plan.uphillForward, "zły kierunek");
    ok(Math.abs(plan.segments.at(-1).z - z[z.length - 1]) < 1e-3 && Math.abs(plan.segments[0].bottom - z[0]) < 1e-3, "brak styku");
    eq(model.diagnostics.issues.filter((i) => i.code === "steps-incline-conflict").length, 0);
  });
  test("brak tagów daje jawne założenia i diagnostykę braków", () => {
    const model = stair(), plan = planOf(model);
    ok(plan.count > 1, "brak stopni"); eq(plan.provenance.count.approximate, true); eq(plan.provenance.material.approximate, true); eq(plan.materialId, profile.surfaces.defaultMaterial);
    for (const code of ["pl.check.steps-count", "pl.check.steps-surface", "pl.check.steps-incline"]) ok(model.diagnostics.issues.some((i) => i.code === code), code);
  });
  test("sprzeczny incline jest raportowany, a edycja tagu od razu zmienia plan", () => {
    const model = stair({ incline: "down", step_count: "8" });
    ok(model.diagnostics.issues.some((i) => i.code === "steps-incline-conflict"), "brak konfliktu");
    model.edit((s, src) => (s.setTag("w1", src("w1"), "incline", "up") ? "w1" : null));
    eq(model.diagnostics.issues.filter((i) => i.code === "steps-incline-conflict").length, 0);
    model.edit((s, src) => (s.setTag("w1", src("w1"), "step_count", "12") ? "w1" : null)); eq(planOf(model).count, 12);
    model.edit((s, src) => s.undo(src)); eq(planOf(model).count, 8);
  });
  test("długi bieg dostaje spocznik oznaczony jako założenie", () => {
    const model = scene(profile, [way(1, [[0, 0, 80], [40, 0, 84], [40, 0.1, 84]].slice(0, 2), { highway: "steps", step_count: "26" }, [1, 2])]);
    const plan = planOf(model); ok(plan.landings >= 1, "brak spocznika"); eq(plan.provenance.landings.approximate, true);
    eq(plan.segments.filter((s) => s.kind === "landing").length, plan.landings);
  });
  test("materiał i różowa linia są osobnymi warstwami", () => {
    const model = stair({ surface: "concrete", step_count: "10" }), features = new FeatureRenderer(model, sharedUniforms()), buckets = new Map();
    features._emit(model.states.get("w1"), (kind, def) => { const key = `${kind}|${def.tier}`; if (!buckets.has(key)) buckets.set(key, { kind, range: 0, index: [], count: 0, a: {}, roles: [], push(n, ...v) { (this.a[n] ??= []).push(...v); } }); return buckets.get(key); });
    const stairs = [...buckets.values()].find((b) => b.kind === "stairs"), line = [...buckets.values()].find((b) => b.kind === "stairLine");
    ok(stairs?.count > 0 && line?.count > 0, "brak warstw"); ok(line.roles.every((r) => r === "mark"), "linia nie jest nakładką");
    const heights = line.a.position.filter((_, i) => i % 3 === 2), z = model.states.get("w1").level.z;
    ok(Math.min(...heights) > Math.min(z[0], z.at(-1)) - 0.2 && Math.max(...heights) < Math.max(z[0], z.at(-1)) + 0.2, "linia wystaje poza bieg");
    const pink = new Set(line.a.aColor.map((v) => v.toFixed(3))), base = new Set(stairs.a.aColor.map((v) => v.toFixed(3)));
    ok(![...pink].every((v) => base.has(v)), "kolor linii zmieszany z materiałem");
  });
  test("nieznana wartość surface nie jest zgadywana", () => {
    const model = stair({ surface: "marmur_tęczowy" });
    eq(planOf(model).materialId, profile.surfaces.defaultMaterial); ok(model.diagnostics.issues.some((i) => i.code === "surface-unknown"), "brak ostrzeżenia");
  });
  const roadWay = (tags, coordinates = [[0, 0], [60, 0], [120, 0]], refs = [1, 2, 3]) => way(1, coordinates, { highway: "primary", ...tags }, refs);
  const surfacePlan = (tags, modelProfile = profile) => scene(modelProfile, [roadWay(tags)]).surfaces.byId.get("w1");
  const collectBuckets = (model, id = "w1") => {
    const features = new FeatureRenderer(model, sharedUniforms()), buckets = new Map();
    features._emit(model.states.get(id), (kind, def) => { const key = `${kind}|${def.group}`; if (!buckets.has(key)) buckets.set(key, { kind, group: def.group, range: 0, index: [], count: 0, a: {}, roles: [], push(n, ...v) { (this.a[n] ??= []).push(...v); } }); return buckets.get(key); });
    return [...buckets.values()];
  };
  test("materiał wynika z surface, a brak tagu nie jest zgadywany", () => {
    const tagged = surfacePlan({ surface: "asphalt" }), missing = surfacePlan({});
    eq(tagged.materialId, "asphalt"); eq(tagged.provenance.surface.approximate, false);
    eq(missing.materialId, profile.surfaces.defaultMaterial); eq(missing.provenance.surface.approximate, true);
  });
  test("linia przebiegu jest osobną warstwą, niezależną od materiału", () => {
    const list = collectBuckets(scene(profile, [roadWay({ surface: "asphalt" })]));
    const fill = list.find((b) => b.kind === "ground"), line = list.find((b) => b.kind === "line");
    eq(line.group, "routeLinesRoads"); eq(fill.group, "roads"); ok(fill.a.aPattern?.length > 0, "brak materiału"); ok(!line.a.aPattern, "linia ma materiał");
    const parent = profile.groups.routeLinesRoads.parent, model = scene(profile, [roadWay({})]), features = new FeatureRenderer(model, sharedUniforms());
    features.setGroupVisible("routeLinesRoads", false); ok(features._groupHidden("routeLinesRoads"), "linia nie znika"); ok(!features._groupHidden("roads"), "ukryto nawierzchnię");
    features.setGroupVisible("routeLinesRoads", true); features.setGroupVisible(parent, false); ok(features._groupHidden("routeLinesRoads"), "warstwa nadrzędna nie działa");
  });
  test("pasy i strzałki powstają tylko z tagów", () => {
    eq(surfacePlan({ oneway: "yes" }).dividers.length, 0);
    const plan = surfacePlan({ oneway: "yes", lanes: "3", "turn:lanes": "left|through|through;right" });
    eq(plan.dividers.length, 2); eq(plan.arrows.length, 3); eq(plan.provenance.markings.approximate, true);
    ok(plan.arrows[0].offset < plan.arrows[1].offset && plan.arrows[1].offset < plan.arrows[2].offset, "zła kolejność pasów");
    eq(surfacePlan({ oneway: "yes", lanes: "3", lane_markings: "no" }).dividers.length, 0);
    eq(surfacePlan({ oneway: "yes", lanes: "3", lane_markings: "yes" }).dividers[0].confirmed, true);
  });
  test("niezgodne turn:lanes nie tworzy strzałek i jest raportowane", () => {
    const model = scene(profile, [roadWay({ oneway: "yes", lanes: "3", "turn:lanes": "left|right" })]);
    eq(model.surfaces.byId.get("w1").arrows.length, 0); ok(model.diagnostics.issues.some((i) => i.code === "turn-lanes-count"), "brak ostrzeżenia");
  });
  test("placement przesuwa rysowaną jezdnię, ale nie dane OSM", () => {
    const model = scene(profile, [roadWay({ oneway: "yes", lanes: "3", placement: "right_of:1" })]), plan = model.surfaces.byId.get("w1"), state = model.states.get("w1");
    ok(Math.abs(plan.centerOffset - 3.25 * 0.5) < 1e-6, `przesunięcie ${plan.centerOffset}`); eq(state.feature.points[1], 0);
    ok(plan.axis[4] < 0, "oś nie poszła w prawo od kierunku wayu");
    eq(new FeatureRenderer(model, sharedUniforms()).axisOf(state), plan.axis);
  });
  test("przejście ma oznakowanie tylko z tagów", () => {
    const zebra = way(2, [[-20, 0], [20, 0]], { highway: "footway", footway: "crossing", "crossing:markings": "zebra" }, [8, 9]), none = way(3, [[-20, 12], [20, 12]], { highway: "footway", footway: "crossing", crossing: "uncontrolled" }, [10, 11]);
    const road = way(4, [[0, -40], [0, 40]], { highway: "primary", width: "8" }, [12, 13]), model = scene(profile, [zebra, none, road]);
    const painted = model.surfaces.byId.get("w2").crossing;
    eq(painted.parts[0].pattern, "zebra"); eq(model.surfaces.byId.get("w3").crossing, null); eq(painted.spans.length, 1);
    ok(Math.abs(painted.spans[0][0] - 16) <= 0.5 && Math.abs(painted.spans[0][1] - 24) <= 0.5, `malowanie poza jezdnią: ${painted.spans}`);
    ok(collectBuckets(model, "w2").some((b) => b.group === "roadMarkings"), "brak oznakowania"); ok(!collectBuckets(model, "w3").some((b) => b.group === "roadMarkings"), "zgadnięte oznakowanie");
  });
  test("zebra i przejazd rowerowy są rozpoznawane osobno, także ze wspólnego węzła", () => {
    const road = way(4, [[0, -40], [0, 40]], { highway: "primary", width: "8" }, [12, 50, 13]);
    road.points = [0, -40, 80, 0, 0, 80, 0, 40, 80];
    const walk = way(5, [[-20, 0], [0, 0], [20, 0]], { highway: "footway", footway: "crossing" }, [30, 50, 31]), ride = way(6, [[-20, 0], [0, 0], [20, 0]], { highway: "cycleway", cycleway: "crossing" }, [32, 50, 33]);
    const model = scene(profile, [road, walk, ride, point(50, 0, 0, { highway: "crossing", "crossing:markings": "zebra;dots" })]), plans = model.surfaces.byId;
    eq(plans.get("w5").crossing.parts.map((p) => p.pattern), ["zebra"]); eq(plans.get("w6").crossing.parts.map((p) => p.pattern), ["blocks"]);
    eq(model.surfaces.crossings.size, 0);
    const own = scene(profile, [way(7, [[0, 0], [8, 0]], { highway: "cycleway", cycleway: "crossing" }, [40, 41])]);
    eq(own.surfaces.byId.get("w7").crossing, null);
  });
  test("footway=crossing nie oznacza malowania; zebrę daje marked, a tag węzła tylko jego jezdnię", () => {
    const roads = () => [way(4, [[-10, -40], [-10, 0], [-10, 40]], { highway: "primary", width: "8" }, [60, 61, 62]), way(5, [[10, -40], [10, 0], [10, 40]], { highway: "primary", width: "8" }, [63, 64, 65])];
    const walk = () => way(6, [[-25, 0], [-10, 0], [10, 0], [25, 0]], { highway: "footway", footway: "crossing" }, [66, 61, 64, 67]);
    eq(scene(profile, [...roads(), walk()]).surfaces.byId.get("w6").crossing, null);
    const one = scene(profile, [...roads(), walk(), point(61, -10, 0, { highway: "crossing", crossing: "marked" }), point(64, 10, 0, { highway: "crossing", crossing: "unmarked" })]).surfaces.byId.get("w6").crossing;
    eq(one.parts[0].pattern, "zebra"); eq(one.spans.length, 1); ok(one.spans[0][1] < 25, `malowanie drugiej jezdni: ${one.spans}`);
    const ride = (tags = {}) => way(7, [[-25, 0], [25, 0]], { highway: "cycleway", cycleway: "crossing", ...tags }, [68, 69]);
    eq(scene(profile, [...roads(), ride({ crossing: "marked" })]).surfaces.byId.get("w7").crossing.parts.map((p) => p.pattern), ["blocks"]);
    eq(scene(profile, [...roads(), ride({ crossing: "marked", foot: "designated" })]).surfaces.byId.get("w7").crossing.parts.map((p) => p.pattern), ["blocks"]);
    eq(scene(profile, [...roads(), ride()]).surfaces.byId.get("w7").crossing, null);
    const joined = scene(profile, [...roads(), ride({ crossing: "marked" }), way(10, [[-40, 0], [-25, 0]], { highway: "cycleway" }, [80, 68])]).surfaces.byId.get("w7").crossing;
    eq(joined.spans.length, 2); ok(joined.spans.every(([, , compact]) => !compact), "malowanie na ścieżce dochodzącej");
    const footAndCycle = () => [...roads(), way(8, [[-25, 2], [-10, 0], [10, 2]], { highway: "footway", footway: "crossing" }, [70, 61, 71]), way(9, [[-25, -2], [-10, 0], [10, -2]], { highway: "cycleway", cycleway: "crossing" }, [72, 61, 73]), point(61, -10, 0, { highway: "crossing", crossing: "marked" })];
    const shared = scene(profile, footAndCycle()).surfaces;
    eq(shared.byId.get("w8").crossing.parts.map((p) => p.pattern), ["zebra"]); eq(shared.byId.get("w9").crossing.parts.map((p) => p.pattern), ["blocks"]); eq(shared.crossings.size, 0);
  });
  test("teren i płyty mostu przesłaniają obiekty zamiast prześwitywać", () => {
    const { materials } = new FeatureRenderer(scene(profile, [roadWay({})]), sharedUniforms());
    for (const name of ["casing", "ground", "mark"]) { eq(materials[name].depthTest, true, name); eq(materials[name].depthWrite, false, name); }
    // Linie przebiegu są schematem na wierzchu: nie przesłania ich żadna bryła ani teren.
    for (const name of ["line", "stairLine"]) { eq(materials[name].depthTest, false, name); eq(materials[name].depthWrite, false, name); }
    eq(materials.structure.depthWrite, true); ok(materials.structure.uniforms.uDepthPush.value > 0, "płyta bez odsunięcia głębi");
    for (const name of ["raised", "line", "mark", "stairLine"]) eq(materials[name].polygonOffsetFactor, 0, name);
  });
  test("boczna ścieżka dochodzi do węzła pod trasą główną, bez zaokrąglenia", () => {
    const main = way(1, [[-30, 0], [0, 0], [30, 0]], { highway: "cycleway", width: "6" }, [1, 2, 3]), side = way(2, [[0, 0], [0, 20]], { highway: "footway", width: "2" }, [2, 4]), beside = way(3, [[-30, 4.2], [30, 4.2]], { highway: "footway", width: "2" }, [5, 6]);
    const model = scene(profile, [main, side, beside]), features = new FeatureRenderer(model, sharedUniforms()), state = model.states.get("w2"), end = features._fillEnd(state, true), order = features._drawPriority();
    eq(end.join.type, "flat"); ok(end.over.some((s) => s.feature.id === "w1"), "brak trasy głównej"); ok(end.over.some((s) => s.feature.id === "w3"), "brak trasy obok");
    ok((order.get("w2") ?? 0) < (order.get("w1") ?? 0) && (order.get("w2") ?? 0) < (order.get("w3") ?? 0), "boczna trasa nie leży pod spodem");
    eq(features._fillEnd(state, false).join.type, "flat"); eq(state.feature.points[1], 0);
  });
  test("pasy i strzałki omijają przejście, a linia trasy zwęża się pod malowaniem", () => {
    const road = way(1, [[0, 0], [60, 0], [120, 0]], { highway: "primary", oneway: "yes", lanes: "2", "turn:lanes": "through|right" }, [1, 2, 3]);
    const zebra = way(2, [[106, -20], [106, 20]], { highway: "footway", footway: "crossing", "crossing:markings": "zebra" }, [8, 9]);
    const model = scene(profile, [road, zebra]), plan = model.surfaces.byId.get("w1"), [zone] = plan.coreZones, reach = profile.surfaces.arrowHalfLengthMeters;
    ok(zone[0] < 106 && zone[1] > 106, "brak strefy przejścia");
    for (const [a, b] of plan.dividers[0].dashes) ok(b <= zone[0] || a >= zone[1], `kreska na przejściu: ${a}-${b}`);
    eq(plan.arrows.length, 2); for (const arrow of plan.arrows) ok(arrow.s + reach <= zone[0], `strzałka na przejściu: ${arrow.s}`);
    eq(plan.provenance.arrows.approximate, true);
    const features = new FeatureRenderer(model, sharedUniforms()), line = features._lineThroughCrossings(model.states.get("w1").feature.points, model.states.get("w1").level.z, plan.lineZones);
    eq(line.narrowAt(106), profile.surfaces.routeLineCrossingRatio); eq(line.narrowAt(20), 1); ok(line.withoutZones.some(Number.isNaN), "kolor relacji nie omija przejścia");
    const order = LAYER_ORDER; ok(order.ground < order.mark && Object.entries(order).every(([k, v]) => k === "line" || k === "stairLine" || v < order.line), "linie przebiegu nie leżą na wierzchu");
  });
  test("ścieżka przecinająca jezdnię we wspólnym węźle także zwalnia miejsce, ale nie dostaje malowania", () => {
    const road = way(1, [[0, 0], [100, 0], [120, 0]], { highway: "primary", oneway: "yes", lanes: "2", "turn:lanes": "through|right" }, [1, 2, 3]);
    const path = way(2, [[100, -10], [100, 0], [100, 10]], { highway: "cycleway" }, [8, 2, 9]), model = scene(profile, [road, path]), plan = model.surfaces.byId.get("w1");
    eq(model.surfaces.byId.get("w2").crossing, null); eq(plan.coreZones.length, 0); ok(plan.clearZones.some(([a, b]) => a < 100 && b > 100), "brak strefy");
    const [[from, to]] = plan.clearZones, reach = profile.surfaces.arrowHalfLengthMeters;
    for (const arrow of plan.arrows) ok(arrow.s + reach <= from + 1e-6 || arrow.s - reach >= to - 1e-6, "strzałka na ścieżce");
    for (const [a, b] of plan.dividers[0].dashes) ok(b <= from || a >= to, "kreska na ścieżce");
  });
  test("schody zaczynają się na krawędzi trasy, a nie na jej osi", () => {
    const path = way(3, [[-30, 0, 86], [0, 0, 86], [30, 0, 86]], { highway: "cycleway", width: "6" }, [20, 21, 22]);
    const steps = way(1, [[0, 0, 86], [0, 12, 80]], { highway: "steps" }, [21, 23]), model = scene(profile, [path, steps]), plan = model.stairs.byId.get("w1"), treads = plan.segments.filter((s) => s.kind === "tread");
    ok(Math.abs(plan.highTrim - 3) < 1e-6, `górny koniec: ${plan.highTrim}`); eq(plan.lowTrim, 0);
    ok(treads[treads.length - 1].to <= plan.length - plan.highTrim + 1e-6 && treads[0].from >= plan.lowTrim - 1e-6, "stopnie poza biegiem");
  });
  test("edycja surface i lanes natychmiast zmienia plan i wraca po cofnięciu", () => {
    const model = scene(profile, [roadWay({ surface: "asphalt", oneway: "yes", lanes: "2" })]);
    model.edit((s, src) => (s.setTag("w1", src("w1"), "surface", "paving_stones") ? "w1" : null)); eq(model.surfaces.byId.get("w1").materialId, "pavers");
    model.edit((s, src) => (s.setTag("w1", src("w1"), "lanes", "4") ? "w1" : null)); eq(model.surfaces.byId.get("w1").dividers.length, 3);
    model.edit((s, src) => s.undo(src)); model.edit((s, src) => s.undo(src)); eq(model.surfaces.byId.get("w1").materialId, "asphalt"); eq(model.surfaces.byId.get("w1").dividers.length, 1);
  });
  test("inny profil kraju zmienia materiał i stronę ruchu bez zmian w silniku", () => {
    const other = structuredClone(profile); other.country = "XX"; other.surfaces.drivingSide = "left"; other.surfaces.surfaceMaterials.asphalt = "concrete"; other.surfaces.laneWidthMeters = 4;
    const plan = surfacePlan({ surface: "asphalt", lanes: "2", "turn:lanes:forward": "left", "turn:lanes:backward": "right" }, other), base = surfacePlan({ lanes: "2", "turn:lanes:forward": "left", "turn:lanes:backward": "right" });
    eq(plan.materialId, "concrete"); eq(plan.laneWidth, 4);
    ok(Math.sign(plan.arrows.find((a) => a.travel === 1).offset) !== Math.sign(base.arrows.find((a) => a.travel === 1).offset), "strona ruchu bez zmian");
  });
  const decked = (extra = []) => scene(profile, [way(1, [[0, 0], [60, 0], [120, 0], [180, 0], [240, 0]], { highway: "secondary", bridge: "yes", layer: "1" }, [1, 2, 3, 4, 5]), ...extra]);
  test("pomost bez tagów podpór dostaje podpory wywnioskowane bez tagów OSM", () => {
    const model = decked();
    const { items, stats } = model.supports;
    ok(items.length > 0, "brak podpór"); eq(stats.osm, 0);
    ok(items.every((s) => s.source === "inferred" && s.id.startsWith("inferred:") && !model.states.has(s.id)), "podpora udaje obiekt OSM");
    eq(model.states.get("w1").feature.tags["bridge:support"], undefined);
    const T = profile.inferredSupports.deckThicknessMeters;
    for (const s of items) { eq(s.bottom, 80); ok(s.top < 80 + 5.6 - T + 0.01 && s.top > s.bottom, "zły zakres wysokości"); }
  });
  test("podpora omija drogę pod pomostem albo nie powstaje", () => {
    const model = decked([way(2, [[100, -40], [100, 40]], { highway: "primary" }, [20, 21]), way(3, [[140, -40], [140, 40]], { highway: "primary" }, [22, 23])]);
    for (const s of model.supports.items) ok(Math.abs(s.x - 100) > 5.5 + s.radius && Math.abs(s.x - 140) > 5.5 + s.radius, `podpora w jezdni x=${s.x}`);
  });
  test("podpora nie stoi w wodzie", () => {
    const water = way(2, [[-10, -30], [250, -30], [250, 30], [-10, 30], [-10, -30]], { natural: "water" }, [30, 31, 32, 33, 30]);
    const model = decked([water]);
    eq(model.supports.stats.inferred, 0); ok(model.supports.stats.blocked.water > 0, "brak powodu");
    ok(model.diagnostics.issues.some((i) => i.code === "support-unplaced"), "brak diagnostyki");
  });
  test("bridge:support z OSM jest podporą źródłową, a man_made=pier nie", () => {
    const osm = point(90, 120, 0, { "bridge:support": "pier" });
    const pier = way(5, [[60, 3], [70, 3], [70, 9], [60, 9], [60, 3]], { man_made: "pier", area: "yes" }, [50, 51, 52, 53, 50]);
    const model = decked([osm, pier]);
    ok(model.supports.byId.get("n90")?.source === "osm", "brak podpory OSM");
    eq(model.states.get("w5").interp.classId, "structure.pier");
    ok(!model.supports.items.some((s) => s.id === "w5" || s.deckId === "w5"), "pomost przerobiony na podporę");
    ok(!model.supports.items.some((s) => s.source === "inferred" && Math.hypot(s.x - 120, s.y) < profile.inferredSupports.mergeDistanceMeters), "dublet podpory");
  });
  test("ściana pomostu nie sięga poniżej jego grubości", () => {
    const model = decked(), features = new FeatureRenderer(model, sharedUniforms());
    eq(auditHangingWalls({ model, features }).runs, 0);
  });
  test("nawierzchnia pomostu jest ciągła i leży na wysokości górnych krawędzi boków", () => {
    const model = scene(profile, [way(1, [[0, 0], [60, 0], [120, 12], [180, 30], [240, 30]], { highway: "secondary", bridge: "yes", layer: "1" }, [1, 2, 3, 4, 5])]);
    const state = model.states.get("w1"), features = new FeatureRenderer(model, sharedUniforms());
    const g = sectionGeometry(features, state), { points } = state.feature, { z } = state.level;
    ok(g.walls.length > 0, "brak boków"); eq(g.degenerate, 0); eq(g.wrongNormals, 0);
    for (const wall of g.walls) ok(g.edges.some((e) => Math.hypot(e[0] - wall.p[0], e[1] - wall.p[1], e[2] - wall.p[2]) < 1e-3), "bok poza krawędzią nawierzchni");
    const height = surfaceZ(g.top, points[6], points[7]);
    ok(Math.abs(height - z[2]) < 1e-3, "nawierzchnia poza niweletą");
    ok(surfaceZ(g.top, points[3] + 1, points[4] + 2) !== null, "szczelina w nawierzchni");
  });
  test("płyta mostu leży tuż pod pomostem i go nie przykrywa", () => {
    const outline = way(1, [[0, -20], [400, -20], [400, 20], [0, 20], [0, -20]], { man_made: "bridge", layer: "1" }, [1, 2, 3, 4, 1]);
    const deck = way(2, [[-20, 0], [100, 0], [200, 0], [300, 0], [420, 0]], { highway: "secondary", bridge: "yes", layer: "1" }, [5, 6, 7, 8, 9]);
    const model = scene(profile, [outline, deck]);
    const report = auditBridgePlates({ model, features: new FeatureRenderer(model, sharedUniforms()) });
    eq(report.plates, 1); ok(report.samples > 0, "brak próbek"); eq(report.aboveDeck, 0); ok(report.maxBelowDeck < 1.3, `płyta za nisko: ${report.maxBelowDeck}`);
  });
  test("teren jest dopasowany do trasy, a trasa ani poziomy się nie zmieniają", () => {
    const model = scene(profile, [way(1, [[0, 0, 80], [80, 0, 80]], { highway: "footway", width: "2" }, [1, 2]), way(2, [[0, 40, 90], [80, 40, 90]], { highway: "primary", bridge: "yes", layer: "1" }, [3, 4])]);
    const before = Array.from(model.states.get("w1").level.z), conform = new GroundConform([-100, -100, 180, 180]); conform.rebuild(model);
    const onWay = conform.sample(40, 0); eq(onWay.weight, 1); ok(Math.abs(onWay.height - model.states.get("w1").level.z[0]) < 1e-3, "teren nie leży na trasie");
    ok(conform.sample(40, 5).weight > 0 && conform.sample(40, 5).weight < 1, "brak łagodnego przejścia"); eq(conform.sample(40, 20).weight, 0); eq(conform.sample(40, 40).weight, 0);
    eq(Array.from(model.states.get("w1").level.z), before);
    const crossing = scene(profile, [way(5, [[0, 0, 80], [80, 0, 80]], { highway: "primary" }, [10, 11]), way(6, [[40, -30, 84], [40, 30, 84]], { highway: "footway" }, [12, 13])]), low = new GroundConform([-100, -100, 180, 180]);
    low.rebuild(crossing); ok(Math.abs(low.sample(40, 0).height - crossing.states.get("w5").level.z[0]) < 0.5, "teren nad jezdnią");
  });
  test("bariera bierze wysokość z tagu, potem z typu, a przy nieznanym typie 1 m", () => {
    const heightOf = (tags) => scene(profile, [way(1, [[0, 0], [20, 0]], tags, [1, 2])]).barriers.byId.get("w1");
    const tagged = heightOf({ barrier: "fence", height: "2.2" }); eq(tagged.height, 2.2); eq(tagged.provenance.height.approximate, false);
    const typed = heightOf({ barrier: "wall" }); eq(typed.height, profile.barriers.types.wall.height); eq(typed.provenance.height.approximate, true);
    eq(heightOf({ barrier: "wall", wall: "noise_barrier" }).height, profile.barriers.types.wall.variants.wall.noise_barrier.height);
    eq(heightOf({ barrier: "fence", fence_type: "railing" }).pattern, "railing");
    const unknown = scene(profile, [way(1, [[0, 0], [20, 0]], { barrier: "cokolwiek" }, [1, 2])]); eq(unknown.barriers.byId.get("w1").height, 1); ok(unknown.diagnostics.issues.some((i) => i.code === "barrier-type-unknown"), "brak ostrzeżenia");
  });
  test("brama i trasa tworzą otwór o rzeczywistej szerokości, a ściana go omija", () => {
    const fence = way(1, [[0, 0], [10, 0], [20, 0]], { barrier: "fence" }, [1, 2, 3]), road = way(2, [[10, -20], [10, 0], [10, 20]], { highway: "service", width: "4" }, [4, 2, 5]);
    const model = scene(profile, [fence, road, point(2, 10, 0, { barrier: "gate" })]), plan = model.barriers.byId.get("w1"), gate = model.barriers.byId.get("n2");
    eq(gate.width, 4); eq(plan.spans, [[0, 8], [12, 20]]); eq(gate.direction, [1, 0]);
    const untagged = scene(profile, [way(1, [[0, 0], [10, 0], [20, 0]], { barrier: "fence" }, [1, 2, 3]), way(2, [[10, -20], [10, 0], [10, 20]], { highway: "service", width: "4" }, [4, 2, 5])]);
    eq(untagged.barriers.byId.get("w1").spans.length, 2); ok(untagged.diagnostics.issues.some((i) => i.code === "barrier-passage-untagged"), "brak zgłoszenia przejścia");
    const ending = scene(profile, [way(1, [[0, 0], [10, 0], [20, 0]], { barrier: "fence" }, [1, 2, 3]), way(2, [[10, -20], [10, 0]], { highway: "footway" }, [4, 2])]); eq(ending.barriers.byId.get("w1").spans.length, 1);
  });
  test("bariera nad przejściem pod spodem przeskakuje wycięcie terenu jak most, a zwykłe ogrodzenie idzie po terenie", () => {
    // Wycięcie terenu 7 m głębokości i 16 m szerokości nad ścieżką w tunelu, która przecina barierę w x = 60.
    const dip = (x) => (Math.abs(x - 60) < 8 ? 89 : 96);
    const walk = way(2, [[60, -30, 89], [60, 30, 89]], { highway: "footway", tunnel: "yes", layer: "-1" }, [10, 11]);
    const run = (tags) => {
      const model = scene(profile, [way(1, [[0, 0, 96], [120, 0, 96]], tags, [1, 2]), walk]), features = new FeatureRenderer(model, sharedUniforms());
      features.groundAt = (x) => dip(x);
      const plan = model.barriers.byId.get("w1"), rows = features.barrierProfile(model.states.get("w1"), plan).flat();
      return { plan, lowest: Math.min(...rows.map((r) => r.bottom)), over: rows.filter((r) => Math.abs(r.s - 60) < 6) };
    };
    const wall = run({ barrier: "wall", wall: "noise_barrier" });
    eq(wall.plan.over.map((o) => o.id), ["w2"]); ok(Math.abs(wall.plan.over[0].s - 60) < 0.01, "miejsce przecięcia");
    ok(wall.lowest > 95, `ekran schodzi w wycięcie: ${wall.lowest}`);
    ok(wall.over.every((r) => r.base > 95.5), "podstawa nad przejściem nie leży na wysokości brzegów");
    // Ogrodzenie na tym samym poziomie co trasa (bez tunelu) nie ma pod sobą przejścia i zostaje na terenie.
    const fence = scene(profile, [way(1, [[0, 0, 96], [120, 0, 96]], { barrier: "fence" }, [1, 2]), way(3, [[60, -30, 89], [60, 30, 89]], { highway: "footway" }, [12, 13])]);
    eq(fence.barriers.byId.get("w1").over.length, 0);
  });
  test("ściana oporowa: lico od terenu po prawej (niższej) do terenu po lewej (wyższej) stronie", () => {
    // Linia biegnie na wschód: po lewej (północ, y > 0) teren 95 m, po prawej (południe) 90 m, uskok rozmyty na 2 m jak w NMT.
    const step = (x, y) => 90 + 5 * Math.max(0, Math.min(1, (y + 1) / 2));
    const profileOf = (tags, ground) => {
      const model = scene(profile, [way(1, [[0, 0, 92], [40, 0, 92]], tags, [1, 2])]), features = new FeatureRenderer(model, sharedUniforms());
      features.groundAt = ground;
      const plan = model.barriers.byId.get("w1");
      return { plan, rows: features.barrierProfile(model.states.get("w1"), plan).flat() };
    };
    const wall = profileOf({ barrier: "retaining_wall" }, step);
    ok(wall.plan.retaining, "brak rozpoznania ściany oporowej");
    ok(wall.rows.every((r) => Math.abs(r.base - 90) < 0.25 && Math.abs(r.top - 95) < 0.05), `lico nie sięga od 90 do 95 m: ${wall.rows.map((r) => `${r.base.toFixed(2)}–${r.top.toFixed(2)}`).join(" ")}`);
    // Linia narysowana odwrotnie (wyższa strona po prawej): kierunek rozstrzyga wyraźny uskok w terenie, lico nadal 90–95 m.
    const reversed = profileOf({ barrier: "retaining_wall" }, (x, y) => step(x, -y));
    ok(reversed.rows.every((r) => Math.abs(r.base - 90) < 0.25 && Math.abs(r.top - 95) < 0.05), "odwrócona ściana nie sięga od 90 do 95 m");
    // Bez uskoku w terenie ściana ma wysokość z profilu, jak inne bariery.
    const flat = profileOf({ barrier: "retaining_wall" }, () => 90);
    ok(flat.rows.every((r) => Math.abs(r.top - r.base - flat.plan.height) < 1e-6), "wysokość zastępcza");
    // Zwykły mur w tym samym miejscu nadal stoi na terenie w osi.
    const plain = profileOf({ barrier: "wall" }, step);
    ok(plain.rows.every((r) => r.top === undefined && Math.abs(r.base - 92.5) < 0.25), "zwykły mur zmienił zachowanie");
  });
  test("ściana oporowa z uskokiem: pas cięcia terenu i posadzka po niższej stronie, dół nie wyżej niż chodnik przy ścianie", () => {
    const step = (x, y) => 90 + 5 * Math.max(0, Math.min(1, (y + 1) / 2));
    const walk = way(2, [[0, -2], [40, -2]], { highway: "footway" }, [5, 6]);
    const model = scene(profile, [way(1, [[0, 0, 92], [40, 0, 92]], { barrier: "retaining_wall" }, [1, 2]), walk]);
    model.states.get("w2").level.z.fill(89.4);
    const features = new FeatureRenderer(model, sharedUniforms());
    features.groundAt = step;
    const plan = model.barriers.byId.get("w1"), segments = features.retainingCutSegments();
    ok(features.retainingCuts(plan), "ściana z uskokiem bez cięcia");
    ok(segments.length > 0 && segments.every((s) => s.lower === -1 && s.band === 4), "pas cięcia nie po prawej stronie");
    const rows = features.barrierProfile(model.states.get("w1"), plan).flat();
    ok(rows.every((r) => r.base < 89.6), `dół ściany nad chodnikiem: ${Math.max(...rows.map((r) => r.base)).toFixed(2)}`);
    features.materials.wallFloor = {};
    const buffers = new Map(), bucket = (kind) => buffers.get(kind) ?? buffers.set(kind, { count: 0, index: [], a: {}, push(name, ...v) { (this.a[name] ??= []).push(...v); } }).get(kind);
    features._emitRetainingFloor(model.states.get("w1"), plan, bucket);
    const floor = buffers.get("wallFloor"), ys = floor.a.position.filter((_, i) => i % 3 === 1);
    ok(floor.count > 0 && Math.min(...ys) < -3.9 && Math.max(...ys) <= -0.19, "posadzka nie leży w pasie 0,2–4 m po prawej");
    ok(floor.a.aCell.every((v) => v === -1), "posadzka dopasowywana jak teren");
    // Bez uskoku w terenie: bez cięcia i bez posadzki.
    const flat = new FeatureRenderer(scene(profile, [way(1, [[0, 0, 90], [40, 0, 90]], { barrier: "retaining_wall" }, [1, 2])]), sharedUniforms());
    flat.groundAt = () => 90; eq(flat.retainingCutSegments().length, 0);
  });
  test("jezdnia wchodząca w węźle bariery na most przechodzi nad nią, bez otworu w barierze", () => {
    const wall = way(1, [[0, -20], [0, 0], [0, 20]], { barrier: "retaining_wall" }, [1, 2, 3]);
    const ground = way(2, [[-50, 0], [0, 0]], { highway: "secondary" }, [4, 2]), bridge = way(3, [[0, 0], [50, 0]], { highway: "secondary", bridge: "yes", layer: "1" }, [2, 5]);
    eq(scene(profile, [wall, ground, bridge]).barriers.byId.get("w1").passages.length, 0);
    const through = way(4, [[0, 0], [50, 0]], { highway: "secondary" }, [2, 6]);
    eq(scene(profile, [wall, ground, through]).barriers.byId.get("w1").passages.length, 1);
  });
  test("bariera stoi płynnie na terenie, a dół sięga gruntu", () => {
    const model = scene(profile, [way(1, [[0, 0, 80], [40, 0, 80]], { barrier: "wall" }, [1, 2])]), features = new FeatureRenderer(model, sharedUniforms()), state = model.states.get("w1"), plan = model.barriers.byId.get("w1");
    features.groundAt = (x) => 80 + (Math.floor(x / 4) % 2) * 0.6;
    const [rows] = features.barrierProfile(state, plan);
    for (let i = 1; i < rows.length; i += 1) ok(Math.abs(rows[i].base - rows[i - 1].base) < 0.2, "skok podstawy");
    for (const row of rows) ok(row.bottom <= row.ground, "szczelina pod barierą");
  });
  test("tunel ma prześwit z tagu albo z profilu, portale na wlotach i ciągłą tubę między drogami OSM", () => {
    const a = way(1, [[0, 0, 80], [30, 0, 80]], { highway: "footway", tunnel: "yes", layer: "-1" }, [1, 2]), b = way(2, [[30, 0, 80], [60, 10, 80]], { highway: "footway", tunnel: "yes", layer: "-1", maxheight: "3.2" }, [2, 3]);
    const model = scene(profile, [a, b]), first = model.tunnels.byId.get("w1"), second = model.tunnels.byId.get("w2");
    eq(first.clearance, profile.tunnels.groups.foot.clearance); eq(first.provenance.clearance.approximate, true);
    eq(second.clearance, 3.2); eq(second.provenance.clearance.approximate, false);
    eq(first.portals, { start: true, end: false }); eq(second.portals, { start: false, end: true });
    ok(Math.abs(first.rows[1].nx - second.rows[0].nx) < 1e-9 && Math.abs(first.rows[1].ny - second.rows[0].ny) < 1e-9, "tuby nie mają wspólnego przekroju w węźle");
    eq(first.width, 2 + 2 * profile.tunnels.groups.foot.sideMargin);
    ok(first.cuts[0].bx > 30, "wycięcie nie zachodzi na sąsiednią tubę");
    const planned = scene(profile, [way(5, [[0, 0], [40, 0]], { railway: "proposed", tunnel: "yes" }, [8, 9])]); eq(planned.tunnels.byId.size, 0);
    const bad = scene(profile, [way(6, [[0, 0], [40, 0]], { highway: "service", tunnel: "yes", layer: "-1", maxheight: "wysoki" }, [10, 11])]); ok(bad.diagnostics.issues.some((i) => i.code === "tunnel-value"), "brak zgłoszenia wartości");
  });
  test("woda w przepuście leży na wysokości niższego wlotu, a teren nie jest dopasowany do tunelu", () => {
    const model = scene(profile, [way(1, [[0, 0, 83], [20, 0, 81]], { waterway: "ditch", tunnel: "culvert" }, [1, 2])]), plan = model.tunnels.byId.get("w1");
    eq(plan.kind, "culvert"); eq(Array.from(plan.floor), [81, 81]);
    const conform = new GroundConform([-100, -100, 180, 180]); conform.rebuild(model); eq(conform.sample(10, 0).weight, 0);
  });
  test("kanał ma przełączaną linię przebiegu wody, także w przepuście, bez stref przejść na drogach", () => {
    const model = scene(profile, [way(1, [[0, 0], [40, 0]], { waterway: "canal" }, [1, 2]), way(2, [[40, 0], [60, 0]], { waterway: "canal", tunnel: "culvert" }, [2, 3]), way(3, [[20, -20], [20, 20]], { highway: "service" }, [4, 5])]);
    const open = model.surfaces.byId.get("w1").line, culvert = model.surfaces.byId.get("w2").line;
    eq(open.group, "routeLinesWater"); eq(culvert.group, "routeLinesWater"); eq(model.surfaces.byId.get("w1").surfaced, false);
    eq(model.surfaces.byId.get("w3").clearZones.length, 0);
  });
  test("placement:forward i placement:backward liczą pasy swojego kierunku od osi jezdni", () => {
    const at = (tags) => scene(profile, [roadWay({ lanes: "4", "lanes:forward": "2", "lanes:backward": "2", ...tags })]).surfaces.byId.get("w1");
    const lane = at({}).laneWidth;
    ok(Math.abs(at({ "placement:forward": "middle_of:1" }).centerOffset + lane * 0.5) < 1e-6, "forward middle_of:1");
    ok(Math.abs(at({ "placement:backward": "middle_of:1" }).centerOffset - lane * 0.5) < 1e-6, "backward middle_of:1");
    ok(Math.abs(at({ "placement:forward": "left_of:1" }).centerOffset) < 1e-6, "forward left_of:1 to oś jezdni");
    ok(at({ placement: "middle_of:1" }).issues.some((i) => i.code === "placement-two-way"), "brak ostrzeżenia bez wariantu kierunku");
  });
  test("placement:start i :end zmieniają położenie wzdłuż wayu, a transition łączy sąsiednie odcinki", () => {
    const ramp = scene(profile, [roadWay({ oneway: "yes", lanes: "2", "placement:start": "middle_of:1", "placement:end": "right_of:1" })]).surfaces.byId.get("w1");
    ok(Math.abs(ramp.offsetStart - ramp.laneWidth * 0.5) < 1e-6 && Math.abs(ramp.offsetEnd) < 1e-6, `start ${ramp.offsetStart}, koniec ${ramp.offsetEnd}`);
    const a = way(1, [[0, 0], [50, 0]], { highway: "primary", oneway: "yes", lanes: "2", placement: "middle_of:1" }, [1, 2]);
    const b = way(2, [[50, 0], [70, 0]], { highway: "primary", oneway: "yes", lanes: "2", placement: "transition" }, [2, 3]);
    const c = way(3, [[70, 0], [120, 0]], { highway: "primary", oneway: "yes", lanes: "2" }, [3, 4]);
    const model = scene(profile, [a, b, c]), pa = model.surfaces.byId.get("w1"), pb = model.surfaces.byId.get("w2"), shift = pa.laneWidth * 0.5;
    ok(Math.abs(pa.axis[4] + shift) < 1e-6, "odcinek przed przejściem nie zachowuje położenia do węzła");
    ok(Math.abs(pb.axis[1] + shift) < 1e-6 && Math.abs(pb.axis[4]) < 1e-6, "przejście nie łączy krawędzi sąsiadów");
    eq(model.surfaces.byId.get("w3").axis, model.states.get("w3").feature.points);
    eq(pb.dividers.length, 1);
  });
  test("ciąg odcinków przejściowych zmienia szerokość bez uskoku, a gałęzie rozwidlenia leżą obok siebie", () => {
    const a = way(1, [[0, 0], [50, 0]], { highway: "primary", oneway: "yes", lanes: "3" }, [1, 2]);
    const b = way(2, [[50, 0], [80, 0]], { highway: "primary", oneway: "yes", lanes: "3", placement: "transition", "turn:lanes": "through|through|through" }, [2, 3]);
    const c = way(3, [[80, 0], [90, 0]], { highway: "primary", oneway: "yes", lanes: "4", placement: "transition" }, [3, 4]);
    const d = way(4, [[90, 0], [140, 8]], { highway: "primary", oneway: "yes", lanes: "2" }, [4, 5]);
    const e = way(5, [[90, 0], [140, -8]], { highway: "primary", oneway: "yes", lanes: "2" }, [4, 6]);
    const model = scene(profile, [a, b, c, d, e]), s = (id) => model.surfaces.byId.get(id), lane = s("w1").laneWidth;
    const near = (x, y) => Math.abs(x - y) < 1e-6;
    ok(near(s("w2").widthStart, 3 * lane) && near(s("w2").widthEnd, s("w3").widthStart) && near(s("w3").widthEnd, 4 * lane), `szerokości ${s("w2").widthStart} ${s("w2").widthEnd} ${s("w3").widthStart} ${s("w3").widthEnd}`);
    ok(near(s("w2").widthEnd, 3 * lane + lane * 30 / 40), "szerokość nie zmienia się liniowo wzdłuż ciągu");
    // W węźle gałęzie leżą w przekroju pnia: przesunięcie wzdłuż normalnej pnia, a nie własnej.
    ok(near(s("w4").axis[1], lane) && near(s("w5").axis[1], -lane) && near(s("w4").axis[0], 90) && near(s("w5").axis[0], 90), `gałęzie ${s("w4").axis[1]} ${s("w5").axis[1]}`);
    // Ciąg łączy 3 pasy z rozwidleniem na 2+2 pasy: czwarty pas pojawia się z prawej strony ruchu i ma własną linię.
    eq(s("w2").dividers.length, 3); eq(s("w2").arrows.length, 3); eq(s("w2").lanes, 4);
    ok(near(laneOffset(s("w2"), 1, 30) + s("w2").widthEnd / 2, lane) && near(laneOffset(s("w2"), 3, 30) + s("w2").widthEnd / 2, 3 * lane) && near(laneOffset(s("w2"), 4, 30), s("w2").widthEnd / 2), "granice pasów na odcinku przejściowym");
    ok(near(laneOffset(s("w2"), 3, 0), s("w2").widthStart / 2), "pojawiający się pas ma na początku szerokość 0");
  });
  test("odcinek przejściowy z liczbą pasów spoza zakresu sąsiadów jest raportowany", () => {
    const chain = (middle, last) => scene(profile, [
      way(1, [[0, 0], [50, 0]], { highway: "primary", oneway: "yes", lanes: "3" }, [1, 2]),
      way(2, [[50, 0], [80, 0]], { highway: "primary", oneway: "yes", lanes: middle, placement: "transition" }, [2, 3]),
      way(3, [[80, 0], [130, 0]], { highway: "primary", oneway: "yes", lanes: last }, [3, 4]),
    ]).surfaces.issues.filter((i) => i.code === "transition-lanes").length;
    eq(chain("4", "3"), 1); eq(chain("4", "4"), 0); eq(chain("3", "4"), 0);
  });
  test("width:lanes:end=||0: trzeci pas zanika liniowo do końca wayu", () => {
    const plan = scene(profile, [way(1, [[0, 0], [100, 0]], { highway: "primary", oneway: "yes", lanes: "3", "width:lanes:end": "||0", "turn:lanes": "through|through|through" }, [1, 2])]).surfaces.byId.get("w1");
    const lane = plan.laneWidth, near = (x, y) => Math.abs(x - y) < 1e-6;
    ok(near(plan.widthStart, 3 * lane) && near(plan.widthEnd, 2 * lane), `szerokość ${plan.widthStart} → ${plan.widthEnd}`);
    // Na końcu granica pasów 2 i 3 leży na prawej krawędzi, a w połowie pas 3 ma połowę szerokości.
    ok(near(laneOffset(plan, 2, 100), plan.widthEnd / 2) && near(laneOffset(plan, 3, 50) - laneOffset(plan, 2, 50), lane / 2), "granice pasów");
    eq(plan.arrows.map((a) => a.lane), [0, 1]);
  });
  test("width:lanes ustawia szerokość pasów, także dla oneway=-1 i placement", () => {
    const at = (tags) => scene(profile, [way(1, [[0, 0], [100, 0]], { highway: "primary", ...tags }, [1, 2])]).surfaces.byId.get("w1");
    eq(at({ oneway: "-1", lanes: "2", "width:lanes": "3|3.5" }).laneWidths.start, [3.5, 3]);
    ok(Math.abs(at({ oneway: "yes", lanes: "2", "width:lanes": "3|4", placement: "right_of:1" }).centerOffset - 0.5) < 1e-6, "placement z width:lanes");
    eq(at({ oneway: "yes", lanes: "2", "width:lanes": "3|3|3" }).issues.map((i) => i.code), ["width-lanes-count"]);
    eq(at({ oneway: "yes", lanes: "2", "width:lanes": "3|szeroki" }).issues.map((i) => i.code), ["width-lanes-value"]);
    // Dwukierunkowa: ruch prawostronny, pasy przeciwne z lewej strony wayu w odwrotnej kolejności.
    eq(at({ lanes: "3", "lanes:forward": "2", "lanes:backward": "1", "width:lanes:forward": "3|3.5", "width:lanes:backward": "4" }).laneWidths.start, [4, 3, 3.5]);
  });
  test("odcinek przejściowy 4 → 3 bez width:lanes: zanikający pas ma linię i zwęża się do zera", () => {
    const model = scene(profile, [
      way(1, [[0, 0], [50, 0]], { highway: "primary", oneway: "yes", lanes: "4" }, [1, 2]),
      way(2, [[50, 0], [80, 0]], { highway: "primary", oneway: "yes", lanes: "3", placement: "transition" }, [2, 3]),
      way(3, [[80, 0], [130, 0]], { highway: "primary", oneway: "yes", lanes: "3" }, [3, 4]),
    ]), p = model.surfaces.byId.get("w2"), lane = p.laneWidth, near = (x, y) => Math.abs(x - y) < 1e-6;
    eq(p.lanes, 4); eq(p.dividers.length, 3);
    ok(near(laneOffset(p, 3, 0) + p.widthStart / 2, 3 * lane) && near(laneOffset(p, 3, p.length), p.widthEnd / 2), "granica zanikającego pasu");
    eq(p.provenance.markings.value, "pasy 4 → 3");
  });
  test("odcinek przejściowy z width:lanes:end=||0 łączy 3 pasy z 2 bez zgłoszenia", () => {
    const model = scene(profile, [
      way(1, [[0, 0], [50, 0]], { highway: "primary", oneway: "yes", lanes: "3" }, [1, 2]),
      way(2, [[50, 0], [80, 0]], { highway: "primary", oneway: "yes", lanes: "3", placement: "transition", "width:lanes:end": "||0" }, [2, 3]),
      way(3, [[80, 0], [130, 0]], { highway: "primary", oneway: "yes", lanes: "2" }, [3, 4]),
    ]), p = model.surfaces.byId.get("w2");
    ok(Math.abs(p.widthStart - 3 * p.laneWidth) < 1e-6 && Math.abs(p.widthEnd - 2 * p.laneWidth) < 1e-6, `${p.widthStart} ${p.widthEnd}`);
    eq(model.surfaces.issues.filter((i) => i.code === "transition-lanes").length, 0);
  });
  test("linie pasów przechodzą przez styk jezdni bez przerwy i z jednym rytmem kresek", () => {
    const cfg = profile.surfaces, period = cfg.dashMeters + cfg.gapMeters;
    // Drugi way ma odwrotny kierunek zapisu; kreski liczone wzdłuż ciągu muszą trafić w ten sam rytm.
    const model = scene(profile, [
      way(1, [[0, 0], [47, 0]], { highway: "primary", lanes: "2", "lanes:forward": "1", "lanes:backward": "1" }, [1, 2]),
      way(2, [[110, 0], [47, 0]], { highway: "primary", lanes: "2", "lanes:forward": "1", "lanes:backward": "1" }, [3, 2]),
    ]), a = model.surfaces.byId.get("w1"), b = model.surfaces.byId.get("w2");
    const along = [...a.dividers[0].dashes.map(([x, y]) => [x, y]), ...b.dividers[0].dashes.map(([x, y]) => [110 - 47 - y + 47, 110 - 47 - x + 47])].sort((p, q) => p[0] - q[0]);
    // Na węźle (x = 47) nie ma odstępu skrzyżowania: kreska lub przerwa wynika z rytmu, nie z końca wayu.
    const merged = [];
    for (const d of along) { const last = merged[merged.length - 1]; if (last && d[0] - last[1] < 1e-6) last[1] = d[1]; else merged.push([...d]); }
    const inner = merged.filter(([x, y]) => x > cfg.junctionClearMeters && y < 110 - cfg.junctionClearMeters);
    ok(inner.length > 5, "za mało kresek");
    for (let i = 1; i < inner.length; i += 1) ok(Math.abs(inner[i][0] - inner[i - 1][0] - period) < 1e-6, `rytm przerwany przy ${inner[i][0]}`);
    eq(a.continuous.end, true); eq(b.continuous.end, true); eq(a.continuous.start, undefined);
  });
  test("gałęzie rozwidlenia biegnące bliżej niż ich szerokość są rozsuwane tylko o brakujący odstęp", () => {
    const model = scene(profile, [
      way(1, [[-50, 0], [0, 0]], { highway: "primary", oneway: "yes", lanes: "4" }, [1, 2]),
      way(2, [[0, 0], [40, 2], [80, 4], [120, 30]], { highway: "primary", oneway: "yes", lanes: "2" }, [2, 3, 4, 5]),
      way(3, [[0, 0], [40, -2], [80, -4], [120, -30]], { highway: "primary", oneway: "yes", lanes: "2" }, [2, 6, 7, 8]),
    ]), a = model.surfaces.byId.get("w2").axis, b = model.surfaces.byId.get("w3").axis, lane = model.surfaces.byId.get("w2").laneWidth;
    // W danych gałęzie są 4 m od siebie przy szerokości 6,5 m; po rozsunięciu ich krawędzie się stykają.
    ok(Math.abs(a[4] - b[4] - 2 * lane) < 0.15, `odstęp ${a[4] - b[4]}`);
    // Gdzie gałęzie już się nie nakładają, zostają na swoim miejscu.
    ok(Math.abs(a[10] - 30) < 1e-6 && Math.abs(b[10] + 30) < 1e-6, "przesunięcie poza nakładaniem");
  });
  test("linia krawędziowa: skrzyżowanie trójwlotowe przerywa ją tylko u wlotu", () => {
    const model = scene(profile, [
      way(1, [[0, 0], [50, 0], [100, 0]], { highway: "primary", lanes: "2", surface: "asphalt" }, [1, 2, 3]),
      way(2, [[50, 0], [50, 60]], { highway: "secondary", lanes: "2", surface: "asphalt" }, [2, 4]),
    ]), main = model.surfaces.byId.get("w1").edgeLine.sides, side = model.surfaces.byId.get("w2").edgeLine.sides;
    const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
    // Strona prawa (y < 0) jest ciągła, lewa (wlot y > 0) przerwana na szerokości drogi bocznej.
    eq(main.find((s) => s.side === 1).pieces.length, 1);
    const left = main.find((s) => s.side === -1).pieces;
    eq(left.length, 2);
    ok(near(left[1][0] - left[0][1], 6.5, 1.1), `przerwa u wlotu ${left[1][0] - left[0][1]}`);
    // Linie drogi bocznej zaczynają się na krawędzi drogi głównej, a nie na jej osi.
    for (const s of side) ok(near(s.pieces[0][0], 3.25), `początek linii drogi bocznej ${s.pieces[0][0]}`);
  });
  test("linia krawędziowa: kontynuacja z załamaniem jest ciągła, przecięcie bez wspólnego węzła jej nie przerywa", () => {
    const model = scene(profile, [
      way(1, [[0, 0], [50, 0]], { highway: "primary", lanes: "2", surface: "asphalt" }, [1, 2]),
      way(2, [[50, 0], [97, 17]], { highway: "primary", lanes: "2", surface: "asphalt" }, [2, 3]),
      way(3, [[25, -30], [25, 30]], { highway: "primary", lanes: "2", surface: "asphalt" }, [4, 5]),
    ]), a = model.surfaces.byId.get("w1"), b = model.surfaces.byId.get("w2");
    for (const s of a.edgeLine.sides) eq(s.pieces, [[0, a.length]]);
    for (const s of b.edgeLine.sides) eq(s.pieces, [[0, b.length]]);
  });
  test("linia krawędziowa: tylko jezdnie z pasami na nawierzchni utwardzonej", () => {
    const plan = (tags) => scene(profile, [way(1, [[0, 0], [60, 0]], tags, [1, 2])]).surfaces.byId.get("w1");
    eq(plan({ highway: "footway", lanes: "2", surface: "asphalt" }).edgeLine, undefined);
    eq(plan({ highway: "primary", surface: "asphalt" }).edgeLine, undefined);
    const gravel = plan({ highway: "primary", lanes: "2", surface: "gravel" });
    eq(gravel.edgeLine, undefined); eq(gravel.dividers.length, 0);
    ok(plan({ highway: "primary", lanes: "2", surface: "asphalt" }).edgeLine, "asfalt");
    const unknown = plan({ highway: "primary", lanes: "2" });
    ok(unknown.edgeLine && unknown.provenance.markings.approximate, "bez tagu surface: linia jako przybliżenie");
    eq(plan({ highway: "primary", lanes: "2", surface: "asphalt", lane_markings: "no" }).edgeLine, undefined);
  });
  test("krótki dołek NMT pod drogą jest wypełniany, a głęboki dołek i koniec trasy zostają", () => {
    const zOf = (profile3d) => scene(profile, [way(1, profile3d, { highway: "primary", lanes: "2", surface: "asphalt" })]).states.get("w1").level.z;
    // Rów 1,5 m na 10 m: droga przechodzi nad nim na wysokości sąsiednich punktów.
    const ditch = zOf([[0, 0, 80], [15, 0, 80], [20, 0, 78.5], [25, 0, 80], [40, 0, 80]]);
    ok(Math.abs(ditch[2] - 80) < 0.05, `dołek ${ditch[2]}`);
    // Szerokie obniżenie o łagodnym spadku (dolina, przejazd pod konstrukcją) zostaje: wyższe punkty leżą dalej niż 20 m.
    const valley = zOf([[0, 0, 80], [50, 0, 80], [100, 0, 76], [150, 0, 80], [200, 0, 80]]);
    ok(valley[2] < 76.5, `szerokie obniżenie wypełnione: ${valley[2]}`);
    // Koniec trasy schodzący w dół nie ma wyższego punktu po drugiej stronie.
    const end = zOf([[0, 0, 80], [10, 0, 79.5], [20, 0, 79]]);
    ok(end[2] < 79.3, `koniec trasy ${end[2]}`);
  });
  test("kafle danych: obiekt z dwóch kafli nie jest dublowany, a zmiana sesyjna przetrwa zwolnienie i ponowne wczytanie", () => {
    const model = scene(profile, [way(1, [[0, 0, null], [50, 0, 80]], { highway: "primary" }, [1, 2])]);
    // Kopia z sąsiedniego kafla ma wysokość tam, gdzie pierwszy kafel jej nie miał.
    model.addFeatures([way(1, [[0, 0, 81], [50, 0, 80]], { highway: "primary" }, [1, 2])], {});
    eq(model.states.size, 1); eq(model.states.get("w1").feature.points[2], 81);
    model.edit((s, src) => (s.setTag("w1", src("w1"), "lanes", "2") ? "w1" : null));
    model.addFeatures([], {}, { remove: ["w1"] });
    eq(model.states.has("w1"), false);
    model.addFeatures([way(1, [[0, 0, 81], [50, 0, 80]], { highway: "primary" }, [1, 2])], {});
    eq(model.states.get("w1").tagsNow.lanes, "2");
  });
  test("kafle danych: doczytanie zwraca obiekty nowe i te, którym zmienił się plan; reszta nie", () => {
    const far = way(10, [[2000, 0], [2100, 0]], { highway: "residential" }, [100, 101]);
    const model = scene(profile, [way(1, [[0, 0], [100, 0]], { highway: "secondary" }, [1, 2]), far]);
    // Druga jezdnia dochodzi do końca pierwszej: zmienia się jej plan (połączenie), a odległa droga zostaje bez zmian.
    const { changed } = model.addFeatures([way(2, [[100, 0], [200, 0]], { highway: "secondary" }, [2, 3])], {});
    ok(changed.has("w2"), "brak nowego obiektu"); ok(!changed.has("w10"), "odległa droga uznana za zmienioną");
    const again = model.addFeatures([], {});
    eq(again.changed.size, 0, "ponowne przeliczenie bez zmian");
  });
  test("dopasowanie terenu: przeliczenie regionu i przesunięcie siatki dają to samo co pełne przeliczenie", () => {
    const model = scene(profile, [way(1, [[0, 0, 80], [300, 40, 82]], { highway: "primary" }, [1, 2]), way(2, [[150, -100, 81], [150, 120, 79]], { highway: "footway" }, [3, 4]), way(3, [[400, 0, 85], [500, 10, 85]], { highway: "service" }, [5, 6])]);
    const full = new GroundConform([-200, -200, 700, 300]); full.rebuild(model);
    const partial = new GroundConform([-200, -200, 700, 300]); partial.rebuild(model);
    // Zaburzenie części siatki, potem przeliczenie tylko tego obszaru.
    for (let k = 0; k < partial.data.length; k += 7) partial.data[k] += 3;
    partial.update(model, undefined, [[-200, -200, 700, 300]]);
    let diff = 0;
    for (let k = 0; k < full.data.length; k += 1) diff = Math.max(diff, Math.abs(full.data[k] - partial.data[k]));
    ok(diff < 1e-5, `region różni się o ${diff}`);
    const local = new GroundConform([-200, -200, 700, 300]); local.rebuild(model);
    local.update(model, undefined, [[100, -50, 200, 50]]);
    for (let k = 0; k < full.data.length; k += 1) diff = Math.max(diff, Math.abs(full.data[k] - local.data[k]));
    ok(diff < 1e-5, `przeliczenie fragmentu różni się o ${diff}`);
    // Nowy zasięg przesunięty o 250 m: część wspólna jest kopiowana, a nowa część przeliczana.
    const shifted = new GroundConform([50, -200, 950, 300], full); shifted.update(model, undefined, [[700, -200, 950, 300]]);
    const fresh = new GroundConform([50, -200, 950, 300]); fresh.rebuild(model);
    for (let k = 0; k < fresh.data.length; k += 1) diff = Math.max(diff, Math.abs(fresh.data[k] - shifted.data[k]));
    ok(diff < 1e-5, `po przesunięciu różnica ${diff}`);
    eq(shifted.sample(300, 40).weight, 1);
  });
  test("widok: doczytanie obiektów przebudowuje tylko kawałki w zmienionym obszarze", () => {
    const model = scene(profile, [way(1, [[0, 0], [100, 0]], { highway: "secondary" }, [1, 2]), way(10, [[3000, 0], [3100, 0]], { highway: "residential" }, [100, 101])]);
    const features = new FeatureRenderer(model, sharedUniforms());
    features.groundAt = () => 80;
    for (const key of features.update(model.states.keys(), [], [])) features.rebuildChunk(key);
    const farChunk = model.states.get("w10").chunk, farMeshes = [...features.chunks.get(farChunk).meshes];
    ok(farMeshes.length > 0, "brak siatek odległego kawałka");
    const { changed } = model.addFeatures([way(2, [[100, 0], [200, 0]], { highway: "secondary" }, [2, 3])], {});
    const keys = features.update(changed, [], [[50, -50, 250, 50]]);
    ok(!keys.has(farChunk), "odległy kawałek trafił do przebudowy");
    ok(keys.has(model.states.get("w1").chunk), "sąsiedni kawałek nie trafił do przebudowy");
    for (const key of keys) features.rebuildChunk(key);
    eq(features.chunks.get(farChunk).meshes, farMeshes);
    // Zwolnienie: obiekt znika z kawałka, a pusty kawałek jest usuwany.
    model.addFeatures([], {}, { remove: ["w10"] });
    for (const key of features.update([], ["w10"], [])) features.rebuildChunk(key);
    ok(!features.chunks.has(farChunk), "pusty kawałek został");
  });
  test("roślinność: wymiary drzewa z tagów (Tag:natural=tree), bez tagów założenia profilu", () => {
    const tree = (tags) => interpret({ geometry: "point", relations: [] }, { natural: "tree", ...tags }, compiled).vegetation;
    const tagged = tree({ height: "18", diameter_crown: "9", circumference: "3.14", leaf_type: "needleleaved" });
    eq(tagged.height.value, 18); eq(tagged.crown.value, 9); ok(Math.abs(tagged.trunk.value - 1) < 0.01, "pień z obwodu"); eq(tagged.leafType.value, "needleleaved");
    eq(tagged.height.approximate, false);
    const bare = tree({});
    eq(bare.height.value, profile.vegetation.forms.tree.heightMeters); eq(bare.crown.value, profile.vegetation.forms.tree.crownDiameterMeters);
    eq(bare.height.approximate, true); eq(bare.leafType.value, profile.vegetation.defaultLeafType);
    eq(tree({ height: "250 cm" }).height.value, 2.5);
    eq(tree({ leaf_type: "deciduous" }).leafType.value, profile.vegetation.defaultLeafType);
    const row = interpret({ geometry: "way", closed: false, relations: [] }, { natural: "tree_row" }, compiled);
    eq(row.classId, "line.tree_row"); eq(row.vegetation.placement, "row");
    eq(interpret({ geometry: "way", closed: false, relations: [] }, { natural: "hedge" }, compiled).classId, "line.natural");
    eq(interpret({ geometry: "way", closed: true, relations: [] }, { natural: "scrub" }, compiled).vegetation.form, "shrub");
  });
  test("roślinność: wypełnienie omija otwory i trasy, szpaler sadzi od pierwszego do ostatniego pnia", () => {
    // Siatka wewnątrz kwadratu 40×40 z otworem 16×16: punkty co 8 m, bez otworu.
    const visited = [];
    gridInside([[0, 0, 40, 0, 40, 40, 0, 40, 0, 0], [12, 12, 12, 28, 28, 28, 28, 12, 12, 12]], 8, (i, j) => visited.push([i * 8, j * 8]));
    ok(visited.length > 0 && visited.every(([x, y]) => !(x > 12 && x < 28 && y > 12 && y < 28)), "punkt w otworze");
    eq(visited.length, 21);
    const clipped = []; gridInside([[0, 0, 40, 0, 40, 40, 0, 40, 0, 0]], 8, (i, j) => clipped.push([i, j]), [0, 0, 20, 20]);
    eq(clipped.length, 9, "przycięcie do kwadratu:");
    const n = nextNode; nextNode += 6;
    const forest = way(9101, [[0, 0], [200, 0], [200, 200], [0, 200], [0, 0]], { natural: "wood" }, [n, n + 1, n + 2, n + 3, n]);
    const road = way(9102, [[-10, 100], [210, 100]], { highway: "residential" }, [n + 4, n + 5]);
    const m = nextNode; nextNode += 2;
    const row = way(9103, [[300, 0], [300, 40]], { natural: "tree_row" }, [m, m + 1]);
    const model = scene(profile, [forest, road, row]);
    const cfg = profile.vegetation, clearance = clearanceIndex(model, (s) => s.interp.dimensions.width?.value ?? s.interp.classDef.widthMeters ?? 2);
    const plants = plantsOf(model.states.get("w9101"), cfg, () => 80, clearance);
    const half = (model.states.get("w9102").interp.dimensions.width?.value ?? model.states.get("w9102").interp.classDef.widthMeters) / 2;
    ok(plants.length > 400, `za mało drzew: ${plants.length}`);
    ok(plants.every((p) => Math.abs(p.y - 100) >= half + cfg.clearance.minMeters - 1e-9), "drzewo na jezdni");
    ok(plants.every((p) => p.z === 80 && p.dims[0] === cfg.forms.tree.heightMeters), "wysokość albo teren");
    const trees = plantsOf(model.states.get("w9103"), cfg, () => 80, clearance);
    eq(trees.map((p) => p.y), [0, 8, 16, 24, 32, 40]);
    eq(plantsOf(model.states.get("w9101"), cfg, () => null, clearance).length, 0, "drzewa bez terenu:");
  });
  test("roślinność mokradeł według wetland=* (Key:wetland), trzcina rośnie także w wodzie", () => {
    const wet = (tags) => interpret({ geometry: "way", closed: true, relations: [] }, { natural: "wetland", ...tags }, compiled).vegetation;
    eq(wet({ wetland: "swamp" }).form, "tree"); eq(wet({ wetland: "reedbed" }).form, "reed"); eq(wet({ wetland: "bog" }).form, "dwarfShrub");
    eq(wet({}).form, "sedge"); ok(/brak wetland/.test(wet({}).basis), "pochodzenie założenia");
    eq(wet({ wetland: "tidalflat" }), null);
    eq(interpret({ geometry: "way", closed: true, relations: [] }, { natural: "heath" }, compiled).classId, "land.heath");
    const n = nextNode; nextNode += 8;
    const reed = way(9201, [[0, 0], [60, 0], [60, 60], [0, 60], [0, 0]], { natural: "wetland", wetland: "reedbed" }, [n, n + 1, n + 2, n + 3, n]);
    const swamp = way(9202, [[100, 0], [160, 0], [160, 60], [100, 60], [100, 0]], { natural: "wetland", wetland: "swamp" }, [n + 4, n + 5, n + 6, n + 7, n + 4]);
    const m = nextNode; nextNode += 4;
    const lake = way(9203, [[-10, -10], [170, -10], [170, 70], [-10, 70], [-10, -10]], { natural: "water" }, [m, m + 1, m + 2, m + 3, m]);
    const model = scene(profile, [reed, swamp, lake]);
    const clearance = clearanceIndex(model, (s) => s.interp.dimensions.width?.value ?? s.interp.classDef.widthMeters ?? 2);
    ok(plantsOf(model.states.get("w9201"), profile.vegetation, () => 80, clearance).length > 300, "trzcina w wodzie pominięta");
    eq(plantsOf(model.states.get("w9202"), profile.vegetation, () => 80, clearance).length, 0, "drzewa w wodzie:");
  });
  test("infrastruktura: klasy boisk, ogrodów, masztów i linii napowietrznych z tagów", () => {
    const area = (tags) => interpret({ geometry: "way", closed: true, relations: [] }, tags, compiled);
    const pitch = area({ leisure: "pitch", sport: "soccer", surface: "artificial_turf" });
    eq(pitch.classId, "land.pitch"); eq(pitch.areaColour, profile.sports.surfaces.artificial_turf);
    eq(area({ leisure: "pitch", surface: "marmur" }).areaColour, null);
    eq(area({ leisure: "garden" }).classId, "land.garden"); eq(area({ leisure: "garden" }).vegetation.mix[0].form, "flower");
    eq(area({ leisure: "garden", "garden:type": "community" }).vegetation, null);
    eq(area({ landuse: "flowerbed" }).vegetation.form, "flower");
    eq(interpret({ geometry: "point", relations: [] }, { man_made: "tower", "tower:type": "lighting" }, compiled).classId, "point.floodlight");
    const line = (tags) => interpret({ geometry: "way", closed: false, relations: [] }, tags, compiled).classId;
    eq(line({ power: "minor_line" }), "line.power"); eq(line({ power: "cable" }), "line.utility"); eq(line({ power: "line", location: "underground" }), "line.utility");
  });
  test("infrastruktura: kierunki z tagów, zwis przewodu, wspólne punkty zawieszenia na słupie kątowym", () => {
    const d = directionsOf("90;N");
    ok(Math.abs(d[0][0] - 1) < 1e-9 && Math.abs(d[0][1]) < 1e-9 && Math.abs(d[1][1] - 1) < 1e-9, "kierunki");
    eq(directionsOf("w górę").length, 0);
    const wire = catenary([0, 0, 10], [100, 0, 10], 0.03, 10);
    ok(Math.abs(wire[5][2] - 7) < 1e-9 && wire[0][2] === 10 && wire[10][2] === 10, "zwis 3% w środku przęsła");
    // Linia z trzema słupami i załamaniem 90° na środkowym: przęsła po obu stronach używają tych samych punktów słupa.
    const pole = (id, x, y) => ({ id: `n${id}`, osmType: "node", osmId: id, geometry: "point", tags: { power: "pole" }, meta: {}, relations: [], point: [x, y, 80] });
    const lineWay = { ...way(9301, [[0, 0], [100, 0], [100, 100]], { power: "minor_line", voltage: "15000", cables: "3" }, [9311, 9312, 9313]) };
    const model = scene(profile, [pole(9311, 0, 0), pole(9312, 100, 0), pole(9313, 100, 100), lineWay]);
    const index = powerIndex(model, () => 80), lineIndex = index.lines.get("w9301");
    eq(lineIndex.stops.length, 3); eq(lineIndex.cables, 3);
    const mid = lineIndex.stops[1], at = index.attachments(mid.sup, mid, 3, "w9301");
    // Poprzecznik na dwusiecznej: punkty leżą na prostej y = −(x − 100) przez słup, symetrycznie co 0,8 m.
    ok(at.every(([x, y]) => Math.abs((x - 100) + y) < 1e-9), "poprzecznik nie leży na dwusiecznej");
    ok(Math.abs(Math.hypot(at[0][0] - at[2][0], at[0][1] - at[2][1]) - 1.6) < 1e-9, "rozstaw przewodów");
    eq(at[0][2], 80 + profile.furniture.power.pole.heightMeters - 0.3);
    eq(mid.sup.transmission, false);
  });
  test("boiska: linie tylko na obrysie prostokątnym o proporcjach dyscypliny, skalowane od linii odniesienia", () => {
    const sports = profile.sports, rule = sports.pitches.soccer;
    const rectPoints = (L, W) => [[0, 0], [L, 0], [L, W], [0, W], [0, 0]].flatMap(([x, y]) => [x, y, 80]);
    ok(pitchFrame(rectPoints(105, 68), rule, sports), "pełnowymiarowe boisko odrzucone");
    eq(pitchFrame(rectPoints(105, 20), rule, sports), null, "pas 105 × 20 m:");
    eq(pitchFrame([[0, 0], [100, 0], [0, 68], [0, 0]].flatMap(([x, y]) => [x, y, 80]), rule, sports), null, "trójkąt:");
    const small = pitchFrame(rectPoints(62, 30), rule, sports);
    ok(small, "boisko 62 × 30 m odrzucone");
    // Linia bramkowa na brzegu, pole karne 16,5 m × s od linii bramkowej, koło środkowe 9,15 m × s.
    const [gx] = small.world(52.5, 0), [px] = small.world(52.5 - 16.5, 0), [cx] = small.world(0, 0), [rx] = small.world(9.15, 0);
    ok(Math.abs(Math.abs(gx - px) - 16.5 * small.s) < 1e-6, "pole karne nie od linii bramkowej");
    ok(Math.abs(Math.abs(rx - cx) - 9.15 * small.s) < 1e-6, "koło środkowe");
    ok(Math.abs(Math.abs(gx - cx) - 31) < 1e-6, "linia bramkowa poza brzegiem");
    const kit = drawPitch("soccer", small, rule).kit;
    ok(kit.length === 10 && kit.every((k) => k.from[2] >= 0), "bramki");
  });
  test("bieżnia: tory równoległe do krawężnika wewnętrznego, dobieg w obrysie zewnętrznym ich nie zagina", () => {
    const circle = (r, n, cx = 0, cy = 0) => { const out = []; for (let i = 0; i <= n; i += 1) { const a = (i / n) * Math.PI * 2; out.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); } return out; };
    // Owal (koło r = 30 m), bieżnia 6,2 m (5 torów), a do obrysu zewnętrznego doklejony prostokątny dobieg (x 0…20 m, 15 m w dół).
    const kerb = circle(30, 96), R = 36.2, outer = [];
    for (let i = 0; i <= 96; i += 1) {
      const a = (i / 96) * Math.PI * 2;
      if (a > 1.5 * Math.PI && Math.cos(a) * R < 20) continue;
      outer.push(R * Math.cos(a), R * Math.sin(a));
      if (i === 72) outer.push(0, -R - 15, 20, -R - 15, 20, -Math.sqrt(R * R - 400));
    }
    const feature = { geometry: "multipolygon", polygons: [[outer, kerb]] };
    const lanes = trackLanes(feature, { leisure: "track", sport: "running" }, profile.sports);
    eq(lanes.length, 4, "linie między 5 torami:");
    lanes.forEach((line, k) => ok(line.every(([x, y]) => Math.abs(Math.hypot(x, y) - 30 - 1.22 * (k + 1)) < 0.05), `linia ${k + 1} nie jest równoległa do krawężnika`));
    eq(trackLanes(feature, { leisure: "track", sport: "roller_skating" }, profile.sports).length, 0, "tor bez lanes dla innej dyscypliny:");
    eq(trackLanes(feature, { leisure: "track", sport: "roller_skating", lanes: "2" }, profile.sports).length, 1, "lanes=2:");
  });
  test("teren: pusty kafel grubego poziomu (np. korzeń) nie wyłącza dokładniejszych kafli ani wysokości pod kamerą", () => {
    const system = new TerrainSystem({ rootSize: 1024, cells: 2, maxLevel: 1, rootWest: 0, rootSouth: 0 }, null, () => {});
    system.active = 1e9; // bez pobierania: stany kafli są ustawione ręcznie
    const tile = (z, x, y, state, heights = null) => system.tiles.set(system.key(z, x, y), { key: system.key(z, x, y), z, x, y, state, used: 0, heights, mesh: state === "ready" ? { visible: false } : null, generation: 0 });
    tile(0, 0, 0, "empty");
    tile(1, 0, 0, "ready", new Float32Array(9).fill(100));
    for (const [x, y] of [[1, 0], [0, 1], [1, 1]]) tile(1, x, y, "empty");
    system.update({ x: 100, y: 100, z: 300 }, { intersectsObject: () => true });
    eq(system.stats.drawn, 1, "kafle rysowane:");
    eq(system.tiles.get("1/0/0").mesh.visible, true);
    eq(system.heightAt(100, 100), 100);
    // Kafle poza zasięgiem danych nie są pobierane.
    system.dataExtent = [0, 0, 400, 400];
    system.tiles.delete("1/1/1");
    system.update({ x: 100, y: 100, z: 300 }, { intersectsObject: () => true });
    eq(system.tiles.has("1/1/1"), false, "kafel poza danymi:");
  });
  test("bramy: rodzaj z gate:type i trasy (przesuwna, dwa skrzydła na drodze, jedno na ścieżce), szlaban single/double", () => {
    const gateScene = (gateTags, routeTags) => {
      const n = nextNode; nextNode += 3;
      const fence = way(9401, [[-10, 0], [0, 0], [10, 0]], { barrier: "fence" }, [n, n + 1, n + 2]);
      const m = nextNode; nextNode += 2;
      const route = way(9402, [[0, -10], [0, 0], [0, 10]], routeTags, [m, n + 1, m + 1]);
      const gate = { id: `n${n + 1}`, osmType: "node", osmId: n + 1, geometry: "point", tags: gateTags, meta: {}, relations: [], point: [0, 0, 80] };
      return scene(profile, [fence, route, gate]).barriers.byId.get(`n${n + 1}`);
    };
    const road = gateScene({ barrier: "gate" }, { highway: "service" });
    eq([road.motion, road.leaves], ["swing", 2]);
    const path = gateScene({ barrier: "gate" }, { highway: "footway" });
    eq([path.motion, path.leaves], ["swing", 1]);
    const sliding = gateScene({ barrier: "gate", "gate:type": "sliding" }, { highway: "service" });
    eq([sliding.motion, sliding.leaves], ["sliding", 1]); eq(sliding.provenance.kind.approximate, false);
    const wood = gateScene({ barrier: "gate", material: "wood" }, { highway: "footway" });
    eq(wood.pattern, "planks");
    eq(gateScene({ barrier: "lift_gate", "lift_gate:type": "double" }, { highway: "service" }).leaves, 2);
    eq(gateScene({ barrier: "lift_gate" }, { highway: "service" }).leaves, 1);
    eq(gateScene({ barrier: "wicket_gate" }, { highway: "service" }).leaves, 1);
  });
  test("drzwi: na licu budynku od zewnątrz, rodzaj wejścia i typ drzwi z tagów; bez lica brak drzwi", () => {
    const n = nextNode; nextNode += 4;
    const house = way(9501, [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]], { building: "yes" }, [n, n + 1, n + 2, n + 3, n]);
    const entrance = (id, x, y, tags) => ({ id: `n${id}`, osmType: "node", osmId: id, geometry: "point", tags: { entrance: "yes", ...tags }, meta: {}, relations: [], point: [x, y, 80] });
    const doors = [entrance(9511, 5, 0, {}), entrance(9512, 10, 4, { entrance: "main" }), entrance(9513, 5, 8, { entrance: "garage" }), entrance(9514, 2, 0, { door: "revolving" }), entrance(9515, 30, 30, {})];
    const model = scene(profile, [house, ...doors]);
    const features = new FeatureRenderer(model, sharedUniforms()), fu = features.furniture;
    eq(model.states.get("n9511").interp.classId, "point.entrance");
    const face = fu.facadeAt(5, 0, 0.8);
    ok(Math.abs(face.nx) < 1e-9 && face.ny === -1, "normalna nie wskazuje na zewnątrz");
    eq(fu.facadeAt(30, 30, 0.8), null);
    const solids = (id) => { const b = { count: 0, index: [], a: {}, range: 0, push(name, ...v) { (this.a[name] ??= []).push(...v); } }; const drawn = fu.door(model.states.get(id), b, [0, 0, 0]); return { drawn, b }; };
    const single = solids("n9511"), main = solids("n9512"), garage = solids("n9513"), revolving = solids("n9514");
    ok(single.drawn && main.drawn && garage.drawn && revolving.drawn, "drzwi nie narysowane");
    eq(solids("n9515").drawn, false);
    // Drzwi pojedyncze: wszystkie wierzchołki przed licem (y ≤ 0) i od gruntu do 2,1 m (+ ościeżnica 0,08 m).
    const ys = single.b.a.position.filter((_, i) => i % 3 === 1), zs = single.b.a.position.filter((_, i) => i % 3 === 2);
    ok(ys.every((y) => y <= 1e-9 && y >= -0.2), "drzwi poza licem");
    ok(Math.abs(Math.min(...zs) - 80) < 1e-9 && Math.abs(Math.max(...zs) - 82.18) < 1e-9, `wysokość drzwi ${Math.min(...zs)}–${Math.max(...zs)}`);
    const xs = (r) => r.b.a.position.filter((_, i) => i % 3 === 0);
    ok(Math.abs(Math.max(...xs(single)) - Math.min(...xs(single)) - 1.16) < 1e-9, "szerokość drzwi z ościeżnicą 1,0 + 0,16 m");
    const mainYs = main.b.a.position.filter((_, i) => i % 3 === 1);
    ok(Math.abs(Math.max(...mainYs) - Math.min(...mainYs) - 1.96) < 1e-9, "drzwi główne 1,8 m + ościeżnica");
    ok(garage.b.count > single.b.count, "brama garażowa bez przetłoczeń");
  });
  test("budynek: dół ścian biegnie po rysowanym terenie (bez cokołu), bryła z min_height ma płaski spód", () => {
    const n = nextNode; nextNode += 8;
    const house = way(9601, [[0, 0, 80], [20, 0, 82], [20, 10, 82], [0, 10, 80], [0, 0, 80]], { building: "yes", "building:levels": "2" }, [n, n + 1, n + 2, n + 3, n]);
    const lifted = way(9602, [[40, 0, 84], [60, 0, 86], [60, 10, 86], [40, 10, 84], [40, 0, 84]], { building: "yes", "building:levels": "2", min_height: "3" }, [n + 4, n + 5, n + 6, n + 7, n + 4]);
    const model = scene(profile, [house, lifted]);
    const features = new FeatureRenderer(model, sharedUniforms());
    features.groundAt = (x) => 80 + x * 0.1;
    const bottoms = (id) => { const b = { count: 0, index: [], a: {}, range: 0, push(name, ...v) { (this.a[name] ??= []).push(...v); } }; features._extrude(model.states.get(id), b, [0, 0, 0]); const out = []; for (let i = 0; i < b.count; i += 1) if (b.a.aAo[i] === 0) out.push([b.a.position[i * 3], b.a.position[i * 3 + 2]]); return out; };
    const house3 = bottoms("w9601");
    ok(house3.length > 20, "ściany nie są dzielone");
    // Dół: grunt − 0,03 m, obniżony co najwyżej do gruntu w środku sąsiedniego odcinka (1 m × spadek 10% = 0,1 m).
    ok(house3.every(([x, z]) => z <= 80 + x * 0.1 - 0.03 + 1e-9 && z >= 80 + x * 0.1 - 0.13 - 1e-9), "dół ściany nie leży na terenie");
    const lifted3 = bottoms("w9602");
    ok(lifted3.every(([, z]) => Math.abs(z - lifted3[0][1]) < 1e-9), "spód bryły uniesionej nie jest płaski");
  });
  test("building:part: obrys z częściami nie jest bryłą, części są (Simple 3D Buildings)", () => {
    const box = (id, x0, y0, x1, y1, tags) => { const n = nextNode; nextNode += 4; return way(id, [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], tags, [n, n + 1, n + 2, n + 3, n]); };
    // Obrys w kształcie L z częścią w ramieniu (środek ciężkości obrysu leży poza nim, części — w środku).
    const n = nextNode; nextNode += 6;
    const shapeL = way(9001, [[0, 0], [30, 0], [30, 8], [8, 8], [8, 30], [0, 30], [0, 0]], { building: "yes" }, [n, n + 1, n + 2, n + 3, n + 4, n + 5, n]);
    const partA = box(9002, 0, 0, 30, 8, { "building:part": "yes", "building:levels": "3" });
    const partB = box(9003, 0, 8, 8, 30, { "building:part": "yes", "building:levels": "1" });
    const lonely = box(9004, 100, 0, 120, 10, { building: "yes" });
    const partial = box(9005, 200, 0, 220, 20, { building: "yes" }), small = box(9006, 200, 0, 210, 10, { "building:part": "yes" });
    const model = scene(profile, [shapeL, partA, partB, lonely, partial, small]);
    eq([...model.buildingParts.hidden].sort(), ["w9001", "w9005"]);
    const gaps = model.diagnostics.issues.filter((i) => i.code === "building-parts-gap");
    eq(gaps.map((i) => i.objects[0]), ["w9005"], "zgłoszenie niepokrytego obrysu:");
    ok(/ok\. 25%/.test(gaps[0].message), gaps[0].message);
    eq(model.buildingParts.partsOf.get("w9001").sort(), ["w9002", "w9003"]);
    const features = new FeatureRenderer(model, sharedUniforms());
    const solidCount = (id) => { let count = 0; features._emit(model.states.get(id), (kind) => ({ kind, range: 0, index: [], get count() { return count; }, set count(v) { if (kind === "solid") count = v; }, a: {}, roles: [], push() {} })); return count; };
    eq(solidCount("w9001"), 0, "obrys z częściami:");
    ok(solidCount("w9002") > 0 && solidCount("w9003") > 0 && solidCount("w9004") > 0, "brak bryły części albo zwykłego budynku");
  });
  test("dach: wysokości według Simple 3D Buildings (height z dachem, roof:levels, założenie jednej kondygnacji)", () => {
    const building = (tags) => interpret({ geometry: "way", closed: true, relations: [] }, { building: "yes", ...tags }, compiled).dimensions;
    const levels = building({ "building:levels": "2", "roof:levels": "1", "roof:shape": "gabled" });
    eq(levels.height.value, 9); eq(levels.roof.height.value, 3); eq(levels.roof.shape, "gabled");
    const tagged = building({ height: "10", "roof:height": "2", "roof:shape": "hipped" });
    eq(tagged.height.value, 10); eq(tagged.roof.height.value, 2); eq(tagged.roof.height.approximate, false);
    // Przykład z wiki: building:levels=3, roof:levels=1 bez kształtu dachu daje 12 m.
    eq(building({ "building:levels": "3", "roof:levels": "1" }).height.value, 12);
    const assumed = building({ "building:levels": "1", "roof:shape": "pyramidal" });
    eq(assumed.roof.height.value, 3); eq(assumed.roof.height.approximate, true); eq(assumed.height.value, 6);
    eq(building({ "roof:shape": "pitched" }).roof.shape, "gabled");
    eq(building({ "roof:shape": "sawtooth" }).roof.shape, "flat");
    eq(building({ "roof:shape": "gabled", "roof:direction": "NE", "roof:orientation": "across" }).roof.direction, 45);
    eq(building({ "roof:shape": "gabled", "roof:angle": "30" }).roof.height.value, null);
  });
  test("dach: połacie pokrywają dokładnie obrys (także wklęsły i z otworem), grzbiet wzdłuż dłuższego boku", () => {
    const params = profile.roofs.parameters, V = (x, y) => new THREE.Vector2(x, y);
    const covered = (model) => model.faces.reduce((sum, f) => sum + f.triangles.reduce((s, [i, j, k]) => { const a = f.vertices[i], b = f.vertices[j], c = f.vertices[k]; return s + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2; }, 0), 0);
    const rect = [[V(0, 0), V(20, 0), V(20, 10), V(0, 10)]];
    const gabled = roofModel(rect, { shape: "gabled", wallTop: 100, height: 3, orientation: "along", params });
    ok(Math.abs(covered(gabled) - 200) < 1e-6, "pokrycie prostokąta");
    ok(Math.abs(gabled.top(10, 5) - 103) < 1e-9 && Math.abs(gabled.top(3, 5) - 103) < 1e-9, "grzbiet nie biegnie wzdłuż dłuższego boku");
    ok(Math.abs(gabled.top(10, 0) - 100) < 1e-9, "okap");
    const across = roofModel(rect, { shape: "gabled", wallTop: 100, height: 3, orientation: "across", params });
    ok(Math.abs(across.top(10, 2) - 103) < 1e-9 && Math.abs(across.top(0, 5) - 100) < 1e-9, "across nie obraca grzbietu");
    const hipped = roofModel(rect, { shape: "hipped", wallTop: 100, height: 3, orientation: "along", params });
    ok(Math.abs(hipped.top(10, 5) - 103) < 1e-9 && Math.abs(hipped.top(0, 5) - 100) < 1e-9, "dach czterospadowy");
    const skillion = roofModel(rect, { shape: "skillion", wallTop: 100, height: 3, direction: 90, params });
    ok(Math.abs(skillion.top(0, 5) - 103) < 1e-9 && Math.abs(skillion.top(20, 5) - 100) < 1e-9, "połać jednospadowa nie patrzy na wschód");
    const pyramid = roofModel(rect, { shape: "pyramidal", wallTop: 100, height: 3, params });
    ok(pyramid.faces.some((f) => f.vertices.some((v) => Math.abs(v[0] - 10) < 1e-9 && Math.abs(v[1] - 5) < 1e-9 && Math.abs(v[2] - 103) < 1e-9)), "wierzchołek ostrosłupa");
    // Obrys w kształcie L i obrys z otworem: pokrycie równe polu, wysokości wierzchołków zgodne z dachem.
    const shapeL = [[V(0, 0), V(20, 0), V(20, 8), V(8, 8), V(8, 20), V(0, 20)]];
    const courtyard = [[V(0, 0), V(30, 0), V(30, 20), V(0, 20)], [V(10, 6), V(10, 14), V(20, 14), V(20, 6)]];
    for (const [rings, field] of [[shapeL, 256], [courtyard, 520]]) {
      for (const shape of ["gabled", "hipped", "half-hipped", "gambrel", "mansard", "round", "butterfly", "saltbox"]) {
        const model = roofModel(rings, { shape, wallTop: 100, height: 3, orientation: "along", params });
        ok(Math.abs(covered(model) - field) < 1e-6, `${shape}: pokrycie ${covered(model)} zamiast ${field}`);
        ok(model.faces.every((f) => f.vertices.every((v) => Math.abs(v[2] - model.top(v[0], v[1])) < 1e-9)), `${shape}: połacie nie stykają się`);
      }
    }
  });
  test("connectivity: składnia wartości z wiki OSM", () => {
    eq(parseConnectivity("1:1|2:2,(3)"), [{ from: 1, to: [{ lane: 1, optional: false }] }, { from: 2, to: [{ lane: 2, optional: false }, { lane: 3, optional: true }] }]);
    eq(parseConnectivity("bw:bw|1:1")[0], { from: "bw", to: [{ lane: "bw", optional: false }] });
    eq(parseConnectivity("1,2:1"), null); eq(parseConnectivity("1:(2"), null); eq(parseConnectivity("0:1"), null); eq(parseConnectivity(""), null);
  });
  test("connectivity: złączenie 2+2 w 3 pasy kładzie gałęzie na wskazanych pasach pnia", () => {
    const main = way(1, [[0, 10], [100, 0]], { highway: "primary", oneway: "yes", lanes: "2" }, [11, 50]);
    const link = way(2, [[0, -10], [100, 0]], { highway: "primary_link", oneway: "yes", lanes: "2" }, [12, 50]);
    const trunk = way(3, [[100, 0], [200, 0]], { highway: "primary", oneway: "yes", lanes: "3" }, [50, 13]);
    const rel = (id, from, value) => ({ id, tags: { type: "connectivity", connectivity: value }, members: [{ type: "way", ref: from, role: "from" }, { type: "node", ref: 50, role: "via" }, { type: "way", ref: 3, role: "to" }] });
    const model = scene(profile, [main, link, trunk], { 900: rel(900, 2, "1:3|2:3") }), s = (id) => model.surfaces.byId.get(id), lane = s("w3").laneWidth;
    const near = (x, y) => Math.abs(x - y) < 1e-6, n = (id) => s(id).axis.length - 3;
    // Pas 3 (prawy) pnia: łącznik przy węźle leży 1 pas na prawo od osi pnia i zwęża się do jednego pasa.
    ok(near(s("w2").axis[n("w2")], 100) && near(s("w2").axis[n("w2") + 1], -lane), `łącznik ${s("w2").axis[n("w2") + 1]}`);
    eq(s("w2").forks.end.width, lane);
    // Droga główna bez relacji dostaje pozostałe pasy 1–2.
    ok(near(s("w1").axis[n("w1") + 1], lane / 2), `główna ${s("w1").axis[n("w1") + 1]}`);
    eq(s("w1").provenance.connectivity.approximate, true); eq(s("w2").provenance.connectivity.approximate, false);
    eq(model.surfaces.issues.filter((i) => i.code.startsWith("connectivity")).length, 0);
  });
  test("connectivity: rozwidlenie 4 na 2+2 i błędy relacji są raportowane", () => {
    const trunk = way(1, [[0, 0], [100, 0]], { highway: "primary", oneway: "yes", lanes: "4" }, [21, 60]);
    const left = way(2, [[100, 0], [200, 10]], { highway: "primary", oneway: "yes", lanes: "2" }, [60, 22]);
    const right = way(3, [[100, 0], [200, -10]], { highway: "primary", oneway: "yes", lanes: "2" }, [60, 23]);
    const rel = (id, to, value, via = { type: "node", ref: 60, role: "via" }) => ({ id, tags: { type: "connectivity", connectivity: value }, members: [{ type: "way", ref: 1, role: "from" }, via, { type: "way", ref: to, role: "to" }] });
    const model = scene(profile, [trunk, left, right], { 901: rel(901, 2, "1:1|2:2"), 902: rel(902, 3, "3:1|4:2") }), s = (id) => model.surfaces.byId.get(id), lane = s("w1").laneWidth;
    ok(Math.abs(s("w2").axis[1] - lane) < 1e-6 && Math.abs(s("w3").axis[1] + lane) < 1e-6, `gałęzie ${s("w2").axis[1]} ${s("w3").axis[1]}`);
    const codes = (relations) => scene(profile, [trunk, left, right], relations).surfaces.issues.map((i) => i.code).filter((c) => c.startsWith("connectivity"));
    eq(codes({ 903: rel(903, 2, "1:5") }), ["connectivity-lane"]);
    eq(codes({ 904: rel(904, 2, "1-1") }), ["connectivity-value"]);
    eq(codes({ 905: rel(905, 2, "1:1", { type: "way", ref: 3, role: "via" }) }), ["connectivity-via-way"]);
  });
  test("słup w osi jezdni jest anomalią kontekstową, nie kolizją", () => {
    const m = scene(profile, [road(1, [[-50, 0], [50, 0]], {}), point(77, 0, 1, { highway: "street_lamp" })]);
    const context = m.diagnostics.issues.filter((i) => i.category === "context");
    eq(context.length, 1); eq(context[0].status, "podejrzenie"); eq(context[0].confidence, "niska"); eq(physical(m).length, 0);
  });
  test("sygnalizacja będąca węzłem drogi nie jest anomalią", () => {
    const m = scene(profile, [road(1, [[-50, 0], [0, 0], [50, 0]], {}, [2001, 77, 2003]), point(77, 0, 0, { highway: "traffic_signals" })]);
    eq(m.diagnostics.issues.filter((i) => i.category === "context").length, 0);
  });
  test("wspólna granica budynków nie jest kolizją", () => {
    const a = way(1, [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], { building: "yes" }, [1, 2, 3, 4, 1]);
    const b = way(2, [[10, 0], [20, 0], [20, 10], [10, 10], [10, 0]], { building: "yes" }, [2, 5, 6, 3, 2]);
    eq(physical(scene(profile, [a, b])).length, 0);
  });
  test("niespójny bridge:structure jest raportowany bez rozstrzygania", () => {
    const outline = way(1, [[-20, -20], [20, -20], [20, 20], [-20, 20], [-20, -20]], { man_made: "bridge", "bridge:structure": "cable-stayed" }, [1, 2, 3, 4, 1]);
    const deck = road(2, [[-10, 0], [0, 0], [10, 0]], { bridge: "yes", layer: "1", "bridge:structure": "suspension" });
    const issue = scene(profile, [outline, deck]).diagnostics.issues.find((i) => i.code === "bridge-structure-mismatch");
    ok(issue, "brak wyniku"); eq(issue.category, "uncertain");
  });

  const failed = results.filter((r) => !r.ok);
  document.getElementById("summary").textContent = `Zaliczone: ${results.length - failed.length}/${results.length}`;
  document.getElementById("out").replaceChildren(...results.map((r) => {
    const li = document.createElement("li");
    li.className = r.ok ? "ok" : "bad";
    li.textContent = r.ok ? r.name : `${r.name}: ${r.error}`;
    return li;
  }));
  window.testResults = { total: results.length, failed };
}
main().catch((error) => { document.getElementById("summary").textContent = `Błąd: ${error.message}`; window.testResults = { total: 0, failed: [{ name: "start", error: error.message }] }; });
