// Interpretacja tagów według profilu kraju. Moduł nie zna renderera i nie zmienia danych źródłowych.

const LINE_KEYS = ["highway", "railway", "barrier"];

export function geometryKind(feature, tags) {
  if (feature.geometry === "point") return "point";
  if (feature.geometry === "multipolygon") return "area";
  if (!feature.closed || tags.area === "no") return "line";
  if (tags.area === "yes") return "area";
  if (LINE_KEYS.some((key) => key in tags)) return "line";
  if ("waterway" in tags && tags.waterway !== "riverbank") return "line";
  return "area";
}

function testCondition(condition, tags) {
  const value = tags[condition.key];
  const present = value !== undefined;
  switch (condition.op) {
    case "exists": return present;
    case "absent": return !present;
    case "eq": return value === condition.value;
    case "ne": return present && value !== condition.value;
    case "in": return present && condition.values.includes(value);
    case "notIn": return present && !condition.values.includes(value);
    default: return false;
  }
}

function matches(when, context) {
  const { tags, geometry, classId, relations } = context;
  if (when.geometry && !when.geometry.includes(geometry)) return false;
  if (when.classPrefix && !when.classPrefix.some((prefix) => classId === prefix || classId.startsWith(`${prefix}.`))) return false;
  if (when.memberOfRoute && !relations.some((relation) => when.memberOfRoute.includes(relation.route))) return false;
  if (when.all && !when.all.every((condition) => testCondition(condition, tags))) return false;
  if (when.any && !when.any.some((condition) => testCondition(condition, tags))) return false;
  if (when.none && when.none.some((condition) => testCondition(condition, tags))) return false;
  return true;
}

export function compileProfile(profile) {
  const byOrder = (a, b) => a.order - b.order || a.id.localeCompare(b.id);
  return {
    profile,
    classifyRules: profile.rules.filter((rule) => rule.phase === "classify").sort(byOrder),
    attributeRules: profile.rules.filter((rule) => rule.phase === "attribute").sort(byOrder),
  };
}

function traceEntry(rule, effect) {
  return { ruleId: rule.id, phase: rule.phase, order: rule.order, effect, rationale: rule.rationale, source: rule.source };
}

function parseNumber(raw) {
  const match = /^\s*(-?\d+(?:[.]\d+)?)\s*(m|cm)?\s*$/.exec(raw);
  if (!match) return null;
  return match[2] === "cm" ? Number(match[1]) / 100 : Number(match[1]);
}

const CARDINAL = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };

function readNumber(raw) {
  const match = /^\s*(-?\d+(?:[.,]\d+)?)\s*(m)?\s*$/.exec(raw ?? "");
  return match ? Number(match[1].replace(",", ".")) : null;
}

/**
 * Dach według Key:roof:shape i Simple 3D Buildings. Kształt spoza listy modelowanych (profil roofs.shapes) jest pokazany
 * płasko z niepewnością; roof:shape=many jest według wiki rysowany płasko (zalecane building:part z własnymi dachami).
 * Wysokość: roof:height, potem roof:angle (liczona przy rysowaniu z szerokości budynku), roof:levels × wysokość kondygnacji,
 * a bez tych tagów założenie profilu (roofs.defaultHeightLevels kondygnacji).
 */
function roofOf(tags, profile, warnings, uncertainties) {
  const cfg = profile.roofs, perLevel = profile.dimensions.metersPerLevel, raw = tags["roof:shape"];
  const shape = raw === undefined ? null : cfg.aliases[raw] ?? raw;
  const roof = { tagged: raw ?? null, shape: "flat", height: null, angle: null, direction: null, orientation: tags["roof:orientation"] === "across" ? "across" : "along", colour: null, material: tags["roof:material"] ?? null };
  if (shape === null) uncertainties.push({ code: "roof-default", message: "Brak roof:shape: dach pokazany jako płaski (przybliżenie)." });
  else if (cfg.flatShapes.includes(shape)) {
    if (shape !== "flat") uncertainties.push({ code: "roof-many", message: `roof:shape=${raw}: według wiki dach rysowany płasko; kształty części opisuje building:part z własnym roof:shape.` });
  } else if (!cfg.shapes.includes(shape)) uncertainties.push({ code: "roof-simplified", message: `roof:shape=${raw} nie jest jeszcze modelowany; dach pokazany jako płaski.` });
  else roof.shape = shape;
  if (tags["roof:orientation"] !== undefined && !["along", "across"].includes(tags["roof:orientation"])) warnings.push({ key: "roof:orientation", value: tags["roof:orientation"], message: `Nierozpoznana wartość „${tags["roof:orientation"]}” tagu roof:orientation (along albo across).` });
  const direction = tags["roof:direction"];
  if (direction !== undefined) {
    const degrees = CARDINAL[direction.trim().toUpperCase()] ?? readNumber(direction);
    if (degrees === null) warnings.push({ key: "roof:direction", value: direction, message: `Nierozpoznana wartość „${direction}” tagu roof:direction (stopnie albo kierunek, np. NE).` });
    else roof.direction = ((degrees % 360) + 360) % 360;
  }
  const colour = tags["roof:colour"];
  if (colour) roof.colour = { value: colour, source: "tag roof:colour", approximate: false };
  else if (roof.material && cfg.materials[roof.material]) roof.colour = { value: cfg.materials[roof.material], source: `roof:material=${roof.material} (kolor: założenie profilu)`, approximate: true };
  if (roof.shape === "flat") return roof;
  const height = readNumber(tags["roof:height"]), angle = readNumber(tags["roof:angle"]), levels = readNumber(tags["roof:levels"]);
  if (height !== null && height > 0) roof.height = { value: height, source: "tag roof:height", approximate: false };
  else if (angle !== null && angle > 0 && angle < 90) { roof.angle = angle; roof.height = { value: null, source: `roof:angle=${angle}° (wysokość z szerokości budynku)`, approximate: false }; }
  else if (levels !== null && levels > 0) roof.height = { value: levels * perLevel, source: `roof:levels × ${perLevel} m`, approximate: true };
  else roof.height = { value: cfg.defaultHeightLevels * perLevel, source: `założenie profilu: ${cfg.defaultHeightLevels} kondygnacja (${cfg.defaultHeightLevels * perLevel} m)`, approximate: true };
  return roof;
}

/**
 * Roślinność (Tag:natural=tree, Key:leaf_type): forma, kształt korony i wymiary z tagów albo z założeń profilu.
 * Obwód pnia (circumference, na wysokości 1,3 m) daje średnicę pnia. Dla obszarów tagi wymiarów nie są opisane na wiki,
 * więc lasy i zarośla mają wymiary formy z profilu.
 */
function vegetationOf(classId, tags, attributes, profile) {
  const cfg = profile.vegetation;
  let source = cfg?.sources[classId], basis = null;
  if (!source) return null;
  // Rodzaj roślinności z wartości tagu (np. wetland=swamp to mokradło zalesione); null: obszar bez roślin.
  if (source.byTag) {
    const value = tags[source.byTag], known = value !== undefined && Object.hasOwn(source.values, value);
    basis = known ? `${source.byTag}=${value}` : value === undefined ? `brak ${source.byTag}; założenie profilu` : `nierozpoznany ${source.byTag}=${value}; założenie profilu`;
    source = known ? source.values[value] : source.default;
    if (!source) return null;
  }
  // Mieszanka form (np. ogród: kwiaty i krzewy): wymiary pokazywane w inspektorze to wymiary pierwszej formy.
  const formName = source.form ?? source.mix[0].form;
  const form = cfg.forms[formName], assumed = (value, what) => ({ value, source: `założenie profilu (${form.label}: ${what})`, approximate: true });
  const leafRaw = tags.leaf_type, known = leafRaw === "mixed" || (leafRaw && cfg.crowns[leafRaw]);
  const leafType = known ? { value: leafRaw, source: "tag leaf_type" } : { value: cfg.defaultLeafType, source: leafRaw ? `nierozpoznany leaf_type=${leafRaw}; założenie profilu` : "brak leaf_type; założenie profilu" };
  const height = attributes.height !== undefined ? { value: attributes.height, source: "tag height", approximate: false } : assumed(form.heightMeters, "wysokość");
  const crown = attributes.crownDiameter !== undefined ? { value: attributes.crownDiameter, source: "tag diameter_crown", approximate: false } : assumed(Math.min(form.crownDiameterMeters, height.value), "średnica korony");
  const trunk = attributes.trunkCircumference !== undefined ? { value: attributes.trunkCircumference / Math.PI, source: "tag circumference / π", approximate: false } : assumed(form.trunkDiameterMeters, "średnica pnia");
  return { form: formName, mix: source.mix ?? null, basis, placement: source.placement, spacing: source.spacingMeters ?? null, leafType, height, crown, trunk };
}

export function interpret(feature, tags, compiled) {
  const { profile, classifyRules, attributeRules } = compiled;
  const geometry = geometryKind(feature, tags);
  const relations = feature.relations ?? [];
  const context = { tags, geometry, relations, classId: "" };
  const trace = [];
  const warnings = [];
  const uncertainties = [];

  let classId = "unknown";
  const hits = classifyRules.filter((rule) => matches(rule.when, context));
  if (hits.length) {
    const firstOrder = hits[0].order;
    const tied = hits.filter((rule) => rule.order === firstOrder);
    const classes = new Set(tied.map((rule) => rule.setClass));
    if (classes.size > 1) {
      for (const rule of tied) trace.push(traceEntry(rule, `kandydat: ${rule.setClass}`));
      uncertainties.push({
        code: "rule-conflict",
        message: `Sprzeczne reguły o tym samym priorytecie: ${[...classes].join(", ")}. Obiekt pozostaje nierozpoznany.`,
      });
    } else {
      classId = tied[0].setClass;
      trace.push(traceEntry(tied[0], `klasa: ${classId}`));
    }
  } else {
    uncertainties.push({ code: "no-rule", message: "Żadna reguła profilu nie rozpoznaje tego zestawu tagów." });
  }
  context.classId = classId;
  const classDef = profile.classes[classId];

  const attributes = {};
  for (const rule of attributeRules) {
    if (!matches(rule.when, context)) continue;
    if (rule.setAttributes) {
      Object.assign(attributes, rule.setAttributes);
      trace.push(traceEntry(rule, Object.entries(rule.setAttributes).map(([k, v]) => `${k}=${v}`).join(", ")));
    }
    if (rule.readNumber) {
      const { attribute, key, min, max, integer } = rule.readNumber;
      const value = parseNumber(tags[key]);
      if (value === null || value < min || value > max || (integer && !Number.isInteger(value))) {
        warnings.push({ key, value: tags[key], message: `Wartość „${tags[key]}” tagu ${key} jest nieprawidłowa lub poza zakresem ${min}–${max}; zostaje pominięta w obliczeniach.` });
      } else {
        attributes[attribute] = value;
        trace.push(traceEntry(rule, `${attribute}=${value}`));
      }
    }
  }

  for (const [key, known] of Object.entries(profile.knownValues)) {
    const value = tags[key];
    if (value === undefined) continue;
    if (value.split(";").some((part) => !known.includes(part.trim()))) {
      warnings.push({ key, value, message: `Nierozpoznana wartość „${value}” tagu ${key}.` });
    }
  }

  const dimensions = {};
  if (attributes.width !== undefined) dimensions.width = { value: attributes.width, source: "tag width", approximate: false };
  else if (classDef.carriageway && attributes.lanes && profile.surfaces) dimensions.width = { value: attributes.lanes * profile.surfaces.laneWidthMeters, source: `lanes × ${profile.surfaces.laneWidthMeters} m (założenie profilu)`, approximate: true, basis: "lanes" };
  else if (classDef.widthMeters) dimensions.width = { value: classDef.widthMeters, source: "domyślna szerokość klasy", approximate: true };
  if (classDef.render === "extrude") {
    const { metersPerLevel, defaultBuildingHeightMeters } = profile.dimensions;
    const roof = roofOf(tags, profile, warnings, uncertainties);
    // Simple 3D Buildings: height obejmuje dach, building:levels liczy kondygnacje bez dachu, roof:levels kondygnacje w dachu.
    const roofMeters = roof.height?.value ?? 0, roofLevels = readNumber(tags["roof:levels"]);
    if (attributes.height !== undefined) dimensions.height = { value: attributes.height, source: "tag height (z dachem)", approximate: false };
    else {
      const walls = attributes.levels !== undefined ? { value: Math.max(attributes.levels, 1) * metersPerLevel, source: `building:levels × ${metersPerLevel} m` } : { value: defaultBuildingHeightMeters, source: "domyślna wysokość profilu" };
      // Dach płaski z roof:levels: kondygnacje w dachu dochodzą do bryły (przykład z wiki: 3 + 1 kondygnacja = 12 m).
      const extra = roof.shape === "flat" && roofLevels > 0 ? roofLevels * metersPerLevel : roofMeters;
      const extraSource = roof.shape === "flat" && roofLevels > 0 ? ` + roof:levels × ${metersPerLevel} m` : roofMeters ? ` + dach ${roofMeters} m (${roof.height.source})` : "";
      dimensions.height = { value: walls.value + extra, source: walls.source + extraSource, approximate: true };
    }
    dimensions.minHeight = { value: attributes.minHeight ?? 0, source: attributes.minHeight !== undefined ? "tag min_height" : "brak tagu", approximate: attributes.minHeight === undefined };
    dimensions.roof = roof;
  }

  const issues = [];
  for (const check of profile.checks) {
    if (matches(check.when, context)) {
      issues.push({ checkId: check.id, category: check.category, severity: check.severity, confidence: check.confidence, message: check.message, suggest: check.suggest ?? [], source: check.source });
    }
  }

  const name = profile.labels.nameKeys.map((key) => tags[key]).find(Boolean) ?? null;
  const vegetation = vegetationOf(classId, tags, attributes, profile);
  // Kolor obszaru z wartości tagu (boiska i bieżnie: surface); wartość spoza mapy zostawia kolor klasy.
  const areaColour = classDef.colorByTag ? profile.sports?.surfaces[tags[classDef.colorByTag]] ?? null : null;
  return { geometry, classId, classDef, attributes, dimensions, vegetation, areaColour, trace, warnings, uncertainties, issues, name };
}
