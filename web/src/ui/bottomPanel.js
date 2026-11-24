// Dolny panel: inspektor, edycja tagów i diagnostyka. Rozwija się w górę.
import { severityLabel } from "../core/diagnostics.js";
import { t } from "../i18n.js";
import { h, link, osmUrl } from "./dom.js";

const CATEGORIES = [["physical", "physical"], ["context", "context"], ["missing", "missing"], ["uncertain", "uncertainCat"]];
const LIST_LIMIT = 150;

export class BottomPanel {
  constructor(root, app) {
    this.root = root; this.app = app; this.open = false;
    this.filter = new Set(CATEGORIES.map(([id]) => id));
    this.markers = true;
    this.render();
  }

  render() {
    const { app } = this;
    const state = app.selected ? app.model.states.get(app.selected) : null;
    const support = app.selected && !state ? app.model.supports.byId.get(app.selected) : null;
    const counts = this.counts();
    const summary = state ? `${state.interp.name ?? state.interp.classDef.label} · ${state.feature.osmType} ${state.feature.osmId}` : support ? "Podpora wywnioskowana z geometrii · nie jest obiektem OSM" : t("noSelection");
    const edits = app.model.session.changedFeatureCount();
    const bar = h("div", { class: "bar" },
      h("button", { "aria-expanded": String(this.open), onclick: () => { this.open = !this.open; this.render(); } }, `${t("inspector")} ${this.open ? "▾" : "▴"}`),
      h("span", {}, summary), h("span", { class: "spacer" }),
      edits ? h("span", { class: "chip approx" }, `Zmiany lokalne: ${edits}`) : null,
      CATEGORIES.map(([id, label]) => h("span", { class: `chip ${id}`, title: t(label) }, `${t(label)}: ${counts[id] ?? 0}`)));
    const scroll = [...this.root.querySelectorAll(".column")].map((c) => c.scrollTop);
    const columns = support ? this.supportColumns(support) : [this.tagsColumn(state), this.detailColumn(state)];
    this.root.replaceChildren(bar, this.open ? h("div", { class: "content" }, columns, this.diagnosticsColumn()) : "");
    this.root.querySelectorAll(".column").forEach((c, i) => { c.scrollTop = scroll[i] ?? 0; });
  }

  counts() {
    const counts = {};
    for (const issue of this.app.model.diagnostics.issues) counts[issue.category] = (counts[issue.category] ?? 0) + 1;
    return counts;
  }

  /** Obiekt wywnioskowany nie ma tagów źródłowych, więc nie ma też czego edytować. */
  supportColumns(support) {
    const deck = this.app.model.states.get(support.deckId);
    const { crs } = this.app.model.manifest;
    return [
      h("div", { class: "column" }, h("h3", {}, t("tags")), h("div", { class: "muted" }, "Brak tagów: ten obiekt nie pochodzi z OSM i nie można go edytować ani opublikować."),
        h("div", { class: "small", style: "margin-top:6px" }, "Aby potwierdzić podporę, zmapuj ją w edytorze OSM jako ", link("https://wiki.openstreetmap.org/wiki/Key:bridge:support", "bridge:support"), ".")),
      h("div", { class: "column" }, h("h3", {}, "Pochodzenie"), h("span", { class: "chip approx" }, "wywnioskowana"),
        h("ul", { class: "plain small" },
          h("li", {}, "Reguła: pomost lub dojazd nad terenem bez bridge:support, co ok. ", String(this.app.model.profile.inferredSupports.spacingMeters), " m, poza wodą, budynkami i trasami poniżej."),
          h("li", {}, `Góra: ${support.top.toFixed(2)} m, spód pomostu (przybliżony) · podstawa: ${support.bottom.toFixed(2)} m, NMT · ${crs.vertical}`),
          h("li", {}, `Wysokość słupa: ${(support.top - support.bottom).toFixed(1)} m · szerokość: ${(support.radius * 2).toFixed(1)} m (założenie profilu)`),
          deck ? h("li", {}, "Pomost: ", link(osmUrl(deck.feature.osmType, deck.feature.osmId), `${deck.feature.osmType} ${deck.feature.osmId}`), ` ${deck.interp.name ?? deck.interp.classDef.label}`) : null)),
    ];
  }

  tagsColumn(state) {
    const { app } = this;
    const { session } = app.model;
    if (!state) return h("div", { class: "column muted" }, t("noSelection"));
    const { feature } = state;
    const id = feature.id;
    const rows = session.diff(id, feature.tags).map((row) => h("tr", { class: row.status },
      h("td", {}, h("input", { value: row.key, "aria-label": `${t("key")} ${row.key}`, onchange: (e) => { const next = e.target.value.trim(); if (next) app.edit((s, src) => (s.renameTag(id, src(id), row.key, next) ? id : null)); else this.render(); } })),
      h("td", { class: "src small muted", title: row.source ?? "" }, row.source ?? "—"),
      h("td", {}, h("input", { value: row.value ?? "", placeholder: row.value === null ? "usunięty" : "", "aria-label": `${t("current")} ${row.key}`, onchange: (e) => app.edit((s, src) => (s.setTag(id, src(id), row.key, e.target.value) ? id : null)) })),
      h("td", { class: "act" },
        row.status !== "bez zmian" ? h("button", { title: `Przywróć wartość źródłową ${row.key}`, "aria-label": `Przywróć ${row.key}`, onclick: () => app.edit((s, src) => (s.restoreTag(id, src(id), row.key) ? id : null)) }, "↺") : null,
        row.value !== null ? h("button", { title: `Usuń ${row.key}`, "aria-label": `Usuń ${row.key}`, onclick: () => app.edit((s, src) => (s.deleteTag(id, src(id), row.key) ? id : null)) }, "×") : null)));
    const newKey = h("input", { placeholder: t("addKey"), "aria-label": t("addKey") });
    const newValue = h("input", { placeholder: t("addValue"), "aria-label": t("addValue") });
    const add = () => {
      const key = newKey.value.trim();
      if (!key) return;
      app.edit((s, src) => (s.setTag(id, src(id), key, newValue.value) ? id : null));
      this.root.querySelector('input[aria-label="nowy klucz"]')?.focus();
    };
    newValue.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
    return h("div", { class: "column" },
      h("h3", {}, `${t("tags")} (${Object.keys(state.tagsNow).length})`),
      h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, t("key")), h("th", {}, t("source")), h("th", {}, t("current")), h("th", { class: "act" }, ""))), h("tbody", {}, rows,
        h("tr", {}, h("td", {}, newKey), h("td", {}, ""), h("td", {}, newValue), h("td", { class: "act" }, h("button", { onclick: add, "aria-label": t("add") }, "+"))))),
      h("div", { class: "bar", style: "padding:6px 0" },
        h("button", { disabled: !session.canUndo, onclick: () => app.edit((s, src) => s.undo(src)) }, t("undo")),
        h("button", { disabled: !session.canRedo, onclick: () => app.edit((s, src) => s.redo(src)) }, t("redo")),
        h("button", { disabled: !session.overlays.has(id), onclick: () => app.edit((s, src) => (s.restoreFeature(id, src(id)) ? id : null)) }, t("restoreObject"))),
      h("div", { class: "small muted" }, t("localOnly"), app.lastRecalc ? ` Ostatnie przeliczenie: ${app.lastRecalc}.` : ""));
  }

  detailColumn(state) {
    if (!state) return h("div", { class: "column" });
    const { app } = this;
    const { feature, interp, level } = state;
    const { manifest, profile } = app.model;
    const nmt = manifest.sources[1];
    const sheet = nmt.sheets.find((s) => s.sheet === feature.groundSheet);
    const issues = app.model.issuesFor(feature.id);
    const dim = Object.entries(interp.dimensions).filter(([key]) => key !== "roof").map(([key, d]) => h("li", {}, `${{ width: "Szerokość", height: "Wysokość", minHeight: "Podstawa" }[key]}: ${d.value} m — ${d.source} `, d.approximate ? h("span", { class: "chip approx" }, "przybliżona") : null));
    // Dach: kształt (z roof:shape) i wysokość z pochodzeniem; kierunek i kolor, gdy są w tagach.
    // Roślinność: forma, kształt korony i wymiary z pochodzeniem (tag albo założenie profilu).
    const veg = interp.vegetation;
    if (veg) {
      const forms = app.model.profile.vegetation.forms, label = veg.mix ? veg.mix.map((m) => `${forms[m.form].label} ${Math.round(m.share * 100)}%`).join(", ") : forms[veg.form].label, place = { point: "", row: ` · szpaler co ${veg.spacing} m (założenie profilu)`, fill: ` · wypełnienie co ${veg.spacing} m (założenie profilu)` }[veg.placement];
      const part = (name, d) => `${name} ${Math.round(d.value * 100) / 100} m (${d.source})`;
      dim.push(h("li", {}, `Roślinność: ${label}${veg.basis ? ` (${veg.basis})` : ""}${app.model.profile.vegetation.forms[veg.form].crown ? "" : `, liście ${veg.leafType.value} (${veg.leafType.source})`}${place} · ${[part("wysokość", veg.height), part("korona", veg.crown), part("pień", veg.trunk)].join(" · ")} `, veg.height.approximate || veg.crown.approximate ? h("span", { class: "chip approx" }, "przybliżona") : null));
    }
    const roof = interp.dimensions.roof;
    if (roof) {
      const shape = roof.tagged && roof.tagged !== roof.shape ? `${roof.shape} (roof:shape=${roof.tagged})` : roof.shape;
      const height = roof.height ? ` · wysokość ${roof.height.value ?? `z kąta ${roof.angle}°`}${roof.height.value !== null ? " m" : ""} — ${roof.height.source}` : "";
      const extra = [roof.orientation === "across" ? "grzbiet w poprzek (across)" : null, roof.direction !== null ? `kierunek połaci ${roof.direction}°` : null, roof.colour ? `kolor ${roof.colour.value} (${roof.colour.source})` : null].filter(Boolean).join(" · ");
      dim.push(h("li", {}, `Dach: ${shape}${height}${extra ? ` · ${extra}` : ""} `, roof.height?.approximate || !roof.tagged ? h("span", { class: "chip approx" }, "przybliżony") : null));
    }
    const z = level ? level.z[Math.floor(level.z.length / 2)] : feature.point?.[2] ?? feature.anchor?.[2];
    return h("div", { class: "column" },
      h("h3", {}, t("interpretation")),
      h("div", {}, h("strong", {}, interp.classDef.label), h("span", { class: "muted" }, ` (${interp.classId})`), " · ", link(osmUrl(feature.osmType, feature.osmId), `${feature.osmType} ${feature.osmId}`)),
      interp.classDef.note ? h("div", { class: "small muted" }, interp.classDef.note) : null,
      app.model.buildingParts?.hidden.has(feature.id) ? h("div", { class: "small" }, `Obrys nie jest rysowany jako bryła 3D: ma ${app.model.buildingParts.partsOf.get(feature.id).length} części building:part, które są bryłami (Simple 3D Buildings).`) : null,
      h("h4", {}, `${t("rules")} — profil ${profile.country} ${profile.profileVersion}`),
      h("ul", { class: "plain small" }, interp.trace.map((r) => h("li", {}, link(r.source, r.ruleId), ` → ${r.effect}`, h("div", { class: "muted" }, r.rationale)))),
      h("h4", {}, t("levels")),
      h("ul", { class: "plain small" },
        h("li", {}, `layer: ${interp.attributes.layer ?? "brak"} · konstrukcja: ${interp.attributes.structure ?? "brak"}`),
        z !== undefined && z !== null ? h("li", {}, `Wysokość w scenie (środek): ${Number(z).toFixed(2)} m ${manifest.crs.vertical} `, h("span", { class: "chip approx" }, level?.lifted ? "przybliżona" : "teren"), h("div", { class: "muted" }, level?.method ?? "NMT w punkcie obiektu")) : h("li", {}, "Wysokość: brak danych"),
        dim),
      this.surfaceSection(feature.id),
      this.barrierSection(feature.id),
      this.tunnelSection(feature.id),
      this.stairSection(feature.id),
      interp.warnings.length || interp.uncertainties.length ? h("h4", {}, t("uncertain")) : null,
      h("ul", { class: "plain small" }, interp.warnings.map((w) => h("li", {}, `⚠ ${w.message}`)), interp.uncertainties.map((u) => h("li", {}, u.message))),
      issues.length ? h("h4", {}, `${t("issues")} (${issues.length})`) : null,
      h("ul", { class: "plain small" }, issues.map((issue) => h("li", {}, this.issueBody(issue, true)))),
      this.suggestions(issues),
      feature.relations.length ? h("h4", {}, `${t("relations")} (${feature.relations.length})`) : null,
      h("ul", { class: "plain small" }, feature.relations.slice(0, 30).map((r) => h("li", {}, link(osmUrl("relation", r.id), `${r.type ?? "relacja"} ${r.id}`), ` ${r.name ?? ""} ${r.route ? `(route=${r.route})` : ""} ${r.role ? `rola: ${r.role}` : ""}`))),
      feature.members ? h("div", { class: "small muted" }, `Członkowie relacji: ${feature.members.length}; geometria nie jest scalana z członkami.`) : null,
      h("h4", {}, t("provenance")),
      h("ul", { class: "plain small" },
        h("li", {}, `OSM: wersja ${feature.meta.version ?? "?"}, ${feature.meta.timestamp ?? "brak daty"}; pobrano ${manifest.fetchedAt}`),
        h("li", {}, sheet ? `Grunt: NMT ${sheet.sheet}, ${sheet.date}, błąd wys. ${sheet.verticalErrorMeters} m, ${manifest.crs.vertical}` : "Grunt: brak arkusza NMT w tym miejscu")));
  }

  surfaceSection(id) {
    const { surfaces, profile } = this.app.model, plan = surfaces.byId.get(id), node = surfaces.crossings.get(id);
    if (node) return [h("h4", {}, "Oznakowanie przejścia"), h("ul", { class: "plain small" }, node.parts.map((part) => h("li", {}, `${part.label} `, part.approximate ? h("span", { class: "chip approx" }, "przybliżone") : null, h("div", { class: "muted" }, `tag ${part.source}=${part.value}`))))];
    if (!plan?.surfaced) return null;
    const labels = { surface: "Nawierzchnia", lanes: "Pasy", laneWidth: "Szerokość pasa (m)", placement: "Położenie jezdni", width: "Szerokość jezdni", connectivity: "Połączenie pasów", markings: "Oznakowanie", arrows: "Strzałki", crossing: "Przejście" };
    const rows = Object.entries(plan.provenance).map(([key, item]) => h("li", {}, `${labels[key] ?? key}: ${item.value} `, item.approximate ? h("span", { class: "chip approx" }, "przybliżone") : null, h("div", { class: "muted" }, item.source)));
    const line = plan.line ? h("li", {}, `Linia przebiegu: ${profile.groups[plan.line.group]?.label ?? plan.line.group}`, h("div", { class: "muted" }, "Osobna warstwa; nie wpływa na materiał ani geometrię.")) : null;
    return [h("h4", {}, "Nawierzchnia i oznakowanie"), h("ul", { class: "plain small" }, rows, line)];
  }

  tunnelSection(id) {
    const plan = this.app.model.tunnels?.byId.get(id);
    if (!plan) return null;
    const p = plan.provenance, rows = [["Rodzaj", p.kind], ["Prześwit", p.clearance, "m"], ["Szerokość wnętrza", p.width, "m"], ["Posadzka", p.floor, "m"]];
    const portals = [plan.portals.start ? "początek" : null, plan.portals.end ? "koniec" : null].filter(Boolean);
    return [h("h4", {}, plan.label), h("ul", { class: "plain small" }, rows.map(([label, item, unit]) => h("li", {}, `${label}: ${item.value}${unit ? ` ${unit}` : ""} `, item.approximate ? h("span", { class: "chip approx" }, "przybliżone") : null, h("div", { class: "muted" }, item.source))), h("li", {}, `Wloty: ${portals.length ? portals.join(", ") : "brak (odcinek łączy się z innymi częściami tunelu)"}`))];
  }

  barrierSection(id) {
    const plan = this.app.model.barriers?.byId.get(id);
    if (!plan) return null;
    const p = plan.provenance, rows = plan.kind === "way" ? [["Typ", p.type], ["Wysokość", p.height, "m"], ["Grubość", p.thickness, "m"]] : [["Typ", p.type], ["Wysokość", p.height, "m"], ["Szerokość", p.width, "m"], ...(p.kind ? [["Rodzaj", p.kind]] : [])];
    const passages = (plan.passages ?? []).map((item) => h("li", {}, `Przejście: ${item.width.toFixed(1)} m`, h("div", { class: "muted" }, item.source)));
    return [h("h4", {}, "Bariera"), h("ul", { class: "plain small" }, rows.map(([label, item, unit]) => h("li", {}, `${label}: ${item.value}${unit && typeof item.value === "number" ? ` ${unit}` : ""} `, item.approximate ? h("span", { class: "chip approx" }, "przybliżone") : null, h("div", { class: "muted" }, item.source))), passages)];
  }

  stairSection(id) {
    const plan = this.app.model.stairs.byId.get(id);
    if (!plan) return null;
    const rows = [["Liczba stopni", plan.provenance.count], ["Wysokość stopnia", plan.provenance.riser, "m"], ["Głębokość stopnia", plan.provenance.tread, "m"], ["Szerokość", plan.provenance.width, "m"], ["Kierunek", plan.provenance.direction], ["Spoczniki", plan.provenance.landings], ["Materiał", plan.provenance.material]];
    return [h("h4", {}, "Schody"), h("ul", { class: "plain small" }, rows.map(([label, item, unit]) => h("li", {}, `${label}: ${item.value}${unit ? ` ${unit}` : ""} `, item.approximate ? h("span", { class: "chip approx" }, "przybliżone") : null, h("div", { class: "muted" }, item.source))),
      h("li", {}, `Bieg: ${plan.length.toFixed(1)} m długości, ${plan.rise.toFixed(2)} m różnicy wysokości`), plan.notes.map((note) => h("li", { class: "muted" }, note)))];
  }

  suggestions(issues) {
    const items = new Map();
    for (const issue of issues) for (const s of issue.suggest ?? []) items.set(s.key, s);
    if (!items.size) return null;
    return [h("h4", {}, t("suggestions")), h("ul", { class: "plain small" }, [...items.values()].map((s) => h("li", {}, link(s.doc, s.key), ` — ${s.reason}`)))];
  }

  issueBody(issue, full) {
    return [
      h("span", { class: `chip ${issue.category}` }, issue.status),
      h("span", { class: "small muted" }, `waga ${severityLabel[issue.severity]} · pewność ${issue.confidence}`),
      h("div", {}, issue.message),
      full ? h("div", { class: "small muted" }, issue.reason) : null,
      full && issue.levels ? h("div", { class: "small muted" }, issue.levels.map((l) => `${l.id}: layer ${l.layer ?? "brak"}, z≈${l.z ?? "?"} m`).join(" | ")) : null,
      full ? h("div", { class: "small" }, issue.objects.map((id) => this.objectLink(id))) : null,
    ];
  }

  objectLink(id) {
    const f = this.app.model.states.get(id)?.feature;
    return f ? [link(osmUrl(f.osmType, f.osmId), `${f.osmType} ${f.osmId}`), " "] : id;
  }

  diagnosticsColumn() {
    const { app } = this;
    const { issues, stats } = app.model.diagnostics;
    const camera = app.engine.camera.position;
    const list = issues.filter((issue) => this.filter.has(issue.category))
      .map((issue) => ({ issue, distance: Math.hypot(issue.location[0] - camera.x, issue.location[1] - camera.y) }))
      .sort((a, b) => b.issue.severity - a.issue.severity || a.distance - b.distance);
    const sync = () => { app.engine.setMarkers(this.markers, this.filter); this.render(); };
    return h("div", { class: "column" },
      h("h3", {}, `${t("diagnostics")} (${list.length})`),
      h("div", { class: "filters" }, CATEGORIES.map(([id, label]) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: this.filter.has(id), onchange: (e) => { if (e.target.checked) this.filter.add(id); else this.filter.delete(id); sync(); } }), t(label))),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: this.markers, onchange: (e) => { this.markers = e.target.checked; sync(); } }), t("markers"))),
      h("div", { class: "small muted", style: "margin-bottom:5px" }, `Przecięcia tras w rzucie 2D: ${stats.crossings2d}; rozdzielone tagami: ${stats.separatedByTags}; potwierdzone kolizje: ${stats.confirmedPhysical}; podejrzenia kolizji: ${stats.suspectedPhysical}.`),
      list.slice(0, LIST_LIMIT).map(({ issue, distance }) => h("button", { class: "issue", onclick: () => app.openIssue(issue) }, this.issueBody(issue, false), h("span", { class: "small muted" }, `${Math.round(distance)} m · ${issue.objects.join(", ")}`))),
      list.length > LIST_LIMIT ? h("div", { class: "small muted" }, `Pokazano ${LIST_LIMIT} najważniejszych z ${list.length}.`) : null);
  }
}
