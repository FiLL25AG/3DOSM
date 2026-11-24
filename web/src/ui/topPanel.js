// Górny panel: wyszukiwanie, nawigacja, warstwy, źródła i cache. Rozwija się w dół.
import { t } from "../i18n.js";
import { h, link } from "./dom.js";

const gb = (bytes) => (bytes / 1e9).toFixed(2);

export class TopPanel {
  constructor(root, app) {
    this.root = root; this.app = app; this.open = false;
    this.render();
  }

  render() {
    const { app } = this;
    const { rig } = app.engine;
    const search = h("input", { type: "search", placeholder: t("search"), "aria-label": t("go"), onkeydown: (e) => { if (e.key === "Enter") app.search(search.value); } });
    const places = h("select", { "aria-label": t("places"), onchange: () => { if (places.value) app.goToLocation(app.locations[Number(places.value)]); places.value = ""; } },
      h("option", { value: "" }, t("places")), app.locations.map((l, i) => h("option", { value: String(i) }, `${l.name} — ${l.note}`)));
    const lock = h("button", { class: rig.northLock ? "on" : "", "aria-pressed": String(rig.northLock), onclick: () => { rig.northLock = !rig.northLock; this.render(); } }, t("lockNorth"));
    const bar = h("div", { class: "bar" }, search, h("button", { onclick: () => app.search(search.value) }, t("go")), places,
      h("button", { onclick: () => rig.northUp() }, t("north")), h("button", { onclick: () => rig.topDown() }, t("top")), lock,
      h("span", { class: "spacer" }), h("span", { class: "muted small", id: "stats" }),
      h("button", { "aria-expanded": String(this.open), onclick: () => { this.open = !this.open; this.render(); } }, `${t("layers")} ${this.open ? "▴" : "▾"}`));
    this.root.replaceChildren(bar, this.open ? this.drawer() : "");
    this.updateStats();
  }

  drawer() {
    const { app } = this;
    const { engine, model } = app;
    const manifest = model.manifest;
    const groups = Object.entries(model.profile.groups).map(([id, group]) => h("label", { class: "check", style: group.parent ? "margin-left:18px" : "" },
      h("input", { type: "checkbox", checked: !engine.features.hiddenGroups.has(id), onchange: (e) => { engine.setGroupVisible(id, e.target.checked); this.render(); } }), group.label));
    // Wszystkie linie przebiegu naraz: to grupy wskazane w klasach jako routeLine (drogi, rowery, piesi, także linie na schodach).
    const lineGroups = [...new Set(Object.values(model.profile.classes).map((c) => c.routeLine).filter(Boolean))];
    const linesOn = lineGroups.filter((id) => !engine.features.hiddenGroups.has(id)).length;
    const allLines = h("input", { type: "checkbox", checked: linesOn === lineGroups.length, onchange: (e) => { for (const id of lineGroups) engine.setGroupVisible(id, e.target.checked); this.render(); } });
    allLines.indeterminate = linesOn > 0 && linesOn < lineGroups.length;
    groups.unshift(h("label", { class: "check", style: "font-weight:600" }, allLines, t("allRouteLines")));
    const range = (label, min, max, step, value, format, apply) => {
      const output = h("span", { class: "muted" }, format(value));
      return h("label", { class: "range" }, label, output, h("input", { type: "range", min, max, step, value, oninput: (e) => { const v = Number(e.target.value); output.textContent = format(v); apply(v); } }));
    };
    const limit = h("input", { type: "number", min: "0.1", step: "0.5", value: gb(app.cache?.limitBytes ?? 1e10), style: "width:90px", "aria-label": t("cacheLimit") });
    const [osm, nmt] = manifest.sources;
    const coverage = manifest.terrain.coverageInPolygon;
    return h("div", { class: "drawer" },
      h("div", {}, h("h3", {}, t("layersTitle")), groups),
      h("div", {}, h("h3", {}, t("viewTitle")),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: app.relief, onchange: (e) => { app.relief = e.target.checked; engine.setRelief(app.relief); } }), t("terrain")),
        range(t("detail"), 0.3, 3, 0.1, app.detail, (v) => `${v.toFixed(1)}×`, (v) => { app.detail = v; engine.setDetail(v); }),
        range(t("exaggeration"), 1, 5, 0.5, app.exaggeration, (v) => `${v.toFixed(1)}×`, (v) => { app.exaggeration = v; engine.setExaggeration(v); }),
        h("h3", {}, t("referenceTitle")),
        h("ul", { class: "plain small" }, manifest.missingLayers.map((layer) => h("li", {}, h("strong", {}, layer.label), h("div", { class: "muted" }, layer.reason))))),
      h("div", {}, h("h3", {}, "Źródła aktywne"),
        h("div", { class: "small" }, h("strong", {}, osm.label), ` — ${osm.role}, ${osm.crs}`, h("div", { class: "muted" }, `Pobrano: ${osm.fetchedAt}`), link(osm.license.url, osm.license.name)),
        h("div", { class: "small", style: "margin-top:6px" }, h("strong", {}, nmt.label), ` — ${nmt.role}`,
          h("div", { class: "muted" }, `${nmt.crs}, ${nmt.verticalDatum}, siatka ${nmt.resolution}`),
          h("div", { class: "muted" }, `Arkusze: ${nmt.sheets.length}, data ${[...new Set(nmt.sheets.map((s) => s.date))].join(", ")}`),
          h("div", { class: "muted" }, `Pokrycie poligonu: ${coverage.measuredPercent}% pomiar, ${coverage.interpolatedPercent}% interpolacja, ${coverage.missingPercent}% brak`),
          link(nmt.license.url, nmt.license.status)),
        h("div", { class: "small muted", style: "margin-top:6px" }, `Poligon: ${manifest.polygonInfo.areaKm2} km², rzeka ${manifest.polygonInfo.riverReachMeters} m. Transformacja: ${manifest.crs.transform.operation} (dokładność ${manifest.crs.transform.accuracyMeters} m).`)),
      h("div", {}, h("h3", {}, t("dataTitle")),
        h("div", { class: "small", id: "cache-line" }),
        h("div", { class: "bar", style: "padding:4px 0" }, t("cacheLimit"), limit, h("button", { onclick: () => app.setCacheLimit(Number(limit.value) * 1e9) }, t("save"))),
        h("div", { class: "bar", style: "padding:4px 0" }, h("button", { onclick: () => app.requestRefresh() }, t("refresh")), h("button", { onclick: () => app.runPerf() }, t("perf"))),
        h("div", { class: "small muted", id: "perf-result", style: "white-space:pre-wrap" }, app.perfText ?? "")));
  }

  updateStats() {
    const { app } = this;
    const stats = this.root.querySelector("#stats");
    if (stats && app.engine.terrain) {
      const s = app.engine.terrain.stats;
      const d = app.engine.rig.distance;
      const range = d >= 1000 ? `${(d / 1000).toFixed(d > 1e4 ? 0 : 1)} km` : `${Math.round(d)} m`;
      const d2 = app.tileStatus, data = d2 ? (d2.error ? ` · dane: błąd (${d2.error})` : ` · dane ${d2.ready}/${d2.total}${d2.building || d2.queued ? ` (budowa: ${d2.message || "w kolejce"})` : ""}${d2.errors?.length ? ` · błąd kafla ${d2.errors[0]}` : ""}`) : "";
      stats.textContent = `Kamera ${range} · teren ${s.loaded}/${s.requested}${app.engine.terrain.active ? " · wczytywanie…" : ""}${data}`;
    }
    const cache = this.root.querySelector("#cache-line");
    if (cache && app.cache) {
      const dates = [...(app.tiles?.loaded.values() ?? [])].map((tile) => tile.fetchedAt).filter(Boolean).sort();
      const fetched = dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} – ${dates[dates.length - 1]}`) : app.model.manifest.fetchedAt;
      cache.textContent = `Zajęte ${gb(app.cache.usedBytes)} GB z ${gb(app.cache.limitBytes)} GB; chronione ${gb(app.cache.protectedBytes)} GB. Wczytane kafle: ${app.tiles?.loaded.size ?? 0}, dane z: ${fetched}.`;
    }
  }
}
