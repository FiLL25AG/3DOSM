// Relacja type=connectivity (wiki OSM: Relation:connectivity, status zatwierdzony): które pasy jednej jezdni
// przechodzą w które pasy drugiej. Tu wyznacza położenie gałęzi w przekroju pnia przy rozwidleniu lub złączeniu.
// Pasy liczy się od lewej, patrząc w kierunku jazdy relacji (od from do to), pas 1 jest skrajnie z lewej.

const WIKI = "https://wiki.openstreetmap.org/wiki/Relation:connectivity";
const SIDE_COS = 0.5;

/** Wartość connectivity=*: „1:1|2:2,(3)”; nawias oznacza połączenie wymagające zmiany pasa, bw pas both_ways. Błąd składni daje null. */
export function parseConnectivity(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const lane = (raw) => (raw === "bw" ? "bw" : Number(raw));
  const statements = [];
  for (const part of value.split("|")) {
    const match = /^\s*(bw|[1-9]\d*)\s*:\s*(.+?)\s*$/.exec(part);
    if (!match) return null;
    const to = [];
    for (const raw of match[2].split(",")) {
      const item = /^\s*(\()?\s*(bw|[1-9]\d*)\s*(\))?\s*$/.exec(raw);
      if (!item || Boolean(item[1]) !== Boolean(item[3])) return null;
      to.push({ lane: lane(item[2]), optional: Boolean(item[1]) });
    }
    statements.push({ from: lane(match[1]), to });
  }
  return statements;
}

/** Pasy jednego kierunku jezdni: liczba i liczba pasów leżących przed nimi od lewej strony (patrząc w kierunku jazdy). */
function directionLanes(plan, withWay, drivingSide) {
  if (!plan.lanes) return null;
  if (plan.direction) return (plan.direction === 1) === withWay ? { count: plan.lanes, before: 0 } : null;
  const count = withWay ? plan.lanesForward : plan.lanesBackward;
  if (count === null || count === undefined) return null;
  // Ruch prawostronny: pasy danego kierunku leżą po prawej stronie jezdni.
  return { count, before: drivingSide === "right" ? plan.lanes - count : 0 };
}

/**
 * Wyznacza położenie gałęzi przy węzłach via relacji connectivity. Zapisuje plan.forks (gałąź) i plan.forkTotal (pień)
 * tak samo jak rozpoznane rozwidlenie; zwraca węzły obsłużone przez relacje i zgłoszenia błędów relacji.
 */
export function applyConnectivity(model, plans, ends, drivingSide = "right") {
  const issues = [], handled = new Set(), byNode = new Map();
  const report = (rel, code, message, reason, objects, location) => issues.push({ key: `${code}:r${rel.id}`, code, category: "uncertain", status: "informacja", severity: 1, confidence: "wysoka", message: `Relacja connectivity r${rel.id}: ${message}`, reason, objects, location: location ?? [0, 0, 0], suggest: [{ key: "type=connectivity", reason: "Połączenia pasów między jezdniami.", doc: WIKI }] });
  const at = (entry) => { const p = model.states.get(entry.plan.id).feature.points, k = entry.atStart ? 0 : p.length - 3; return [p[k], p[k + 1], p[k + 2] ?? 0]; };

  for (const rel of model.relations?.values() ?? []) {
    if (rel.tags?.type !== "connectivity") continue;
    const role = (name) => (rel.members ?? []).filter((m) => m.role === name);
    const from = role("from"), via = role("via"), to = role("to");
    const fromId = from[0]?.type === "way" ? `w${from[0].ref}` : null, toId = to[0]?.type === "way" ? `w${to[0].ref}` : null;
    // Relacja sięgająca poza wycinek nie jest oceniana.
    if (!fromId || !toId || !model.states.has(fromId) || !model.states.has(toId)) {
      if (from.length !== 1 || to.length !== 1 || !via.length) report(rel, "connectivity-members", "wymaga jednego from (way), jednego to (way) i węzła lub wayów via.", "Relacja nie zmienia rysunku.", [fromId, toId].filter((id) => id && model.states.has(id)));
      continue;
    }
    const objects = [fromId, toId], statements = parseConnectivity(rel.tags.connectivity);
    if (from.length !== 1 || to.length !== 1 || !via.length) { report(rel, "connectivity-members", "wymaga jednego from (way), jednego to (way) i węzła lub wayów via.", "Relacja nie zmienia rysunku.", objects); continue; }
    if (!statements) { report(rel, "connectivity-value", `nie można odczytać connectivity=${rel.tags.connectivity ?? ""}.`, "Wartość musi mieć postać pas:pasy|pas:pasy, np. 1:1|2:2,(3). Relacja nie zmienia rysunku.", objects); continue; }
    if (via.length > 1 || via[0].type !== "node") { report(rel, "connectivity-via-way", "via jest wayem.", "Połączenie pasów jest w danych, ale położenie jezdni prototyp wyznacza tylko przy via będącym węzłem.", objects); continue; }
    const node = via[0].ref, list = ends.get(node) ?? [];
    const fe = list.find((e) => e.plan.id === fromId), te = list.find((e) => e.plan.id === toId);
    if (!fe || !te) { report(rel, "connectivity-via", `from i to nie kończą się w węźle via n${node}.`, "Relacja nie zmienia rysunku.", objects); continue; }
    // from biegnie do węzła via, to od niego.
    const fromLanes = directionLanes(fe.plan, !fe.atStart, drivingSide), toLanes = directionLanes(te.plan, te.atStart, drivingSide);
    if (!fromLanes || !toLanes) { report(rel, "connectivity-lanes", "brak liczby pasów w kierunku jazdy (lanes, przy drodze dwukierunkowej lanes:forward i lanes:backward) albo kierunek jazdy przeciwny do oneway.", "Relacja nie zmienia rysunku.", objects, at(fe)); continue; }
    const bad = statements.find((s) => (s.from !== "bw" && s.from > fromLanes.count) || s.to.some((t) => t.lane !== "bw" && t.lane > toLanes.count));
    if (bad) { report(rel, "connectivity-lane", `pas spoza zakresu (from ma ${fromLanes.count}, to ma ${toLanes.count} pasów w kierunku jazdy).`, "Relacja nie zmienia rysunku.", objects, at(fe)); continue; }
    if (!byNode.has(node)) byNode.set(node, []);
    byNode.get(node).push({ rel, fe, te, statements, fromLanes, toLanes });
  }

  for (const [node, list] of byNode) {
    const froms = new Set(list.map((c) => c.fe.plan)), tos = new Set(list.map((c) => c.te.plan));
    let trunkSide;
    if (tos.size === 1 && froms.size > 1) trunkSide = "to";
    else if (froms.size === 1 && tos.size > 1) trunkSide = "from";
    else if (froms.size === 1 && tos.size === 1) trunkSide = list[0].toLanes.count >= list[0].fromLanes.count ? "to" : "from";
    else { for (const c of list) report(c.rel, "connectivity-node", `w węźle n${node} relacje nie wskazują jednego pnia.`, "Położenie jezdni wyznacza się dla rozwidlenia lub złączenia: jeden way po jednej stronie węzła.", [c.fe.plan.id, c.te.plan.id], at(c.fe)); continue; }
    const first = list[0], trunk = trunkSide === "to" ? first.te : first.fe, trunkLanes = trunkSide === "to" ? first.toLanes : first.fromLanes;
    // Pasy pnia zajęte przez gałąź; połączenia w nawiasie (ze zmianą pasa) liczą się tylko, gdy nie ma innych.
    const assigned = new Map();
    for (const c of list) {
      const branch = trunkSide === "to" ? c.fe : c.te, lanes = new Set();
      for (const optional of [false, true]) {
        for (const s of c.statements) {
          if (trunkSide === "to") { if (s.from !== "bw") for (const t of s.to) if (t.lane !== "bw" && t.optional === optional) lanes.add(t.lane); }
          else if (s.from !== "bw" && s.to.some((t) => t.lane !== "bw" && t.optional === optional)) lanes.add(s.from);
        }
        if (lanes.size) break;
      }
      if (!lanes.size) continue;
      const prev = assigned.get(branch);
      assigned.set(branch, { entry: branch, lanes: new Set([...(prev?.lanes ?? []), ...lanes]), rels: [...(prev?.rels ?? []), c.rel] });
    }
    // Gałąź bez relacji dostaje pozostałe pasy pnia, gdy tworzą ciągły blok o jej liczbie pasów.
    const dx = trunkSide === "to" ? trunk.hx : -trunk.hx, dy = trunkSide === "to" ? trunk.hy : -trunk.hy;
    const rest = (ends.get(node) ?? []).filter((e) => e !== trunk && !assigned.has(e) && e.hx * trunk.hx + e.hy * trunk.hy < -SIDE_COS);
    if (rest.length === 1) {
      const used = new Set([...assigned.values()].flatMap((a) => [...a.lanes])), free = [];
      for (let k = 1; k <= trunkLanes.count; k += 1) if (!used.has(k)) free.push(k);
      const own = directionLanes(rest[0].plan, trunkSide === "to" ? !rest[0].atStart : rest[0].atStart, drivingSide);
      if (free.length && own?.count === free.length && free[free.length - 1] - free[0] + 1 === free.length) assigned.set(rest[0], { entry: rest[0], lanes: new Set(free), rels: [] });
    }
    if (!assigned.size) continue;
    handled.add(node);
    const trunkPlan = trunk.plan, lw = trunkPlan.laneWidth, width = trunk.width, rx = dy, ry = -dx;
    // Gałęzie układają się wokół narysowanej osi pnia, która przy placement nie leży w węźle.
    const trunkOffset = (trunk.atStart ? trunkPlan.offsetStart : trunkPlan.offsetEnd) ?? trunkPlan.centerOffset ?? 0;
    const sx = (trunk.atStart ? trunk.hy : -trunk.hy) * trunkOffset, sy = (trunk.atStart ? -trunk.hx : trunk.hx) * trunkOffset;
    // Sąsiednie gałęzie w przekroju pnia: od nich gałąź odsuwa się tam, gdzie na siebie nachodzą.
    const ordered = [...assigned.values()].sort((a, b) => Math.min(...a.lanes) - Math.min(...b.lanes));
    const neighboursOf = (item) => { const i = ordered.indexOf(item); return [ordered[i - 1], ordered[i + 1]].filter(Boolean).map((x) => ({ id: x.entry.plan.id, width: x.entry.width })); };
    for (const item of assigned.values()) {
      const { entry, lanes, rels } = item;
      const min = Math.min(...lanes), max = Math.max(...lanes);
      const centre = ((trunkLanes.before + min - 1) + (trunkLanes.before + max)) / 2 * lw, offset = centre - width / 2;
      entry.plan.forks ??= {};
      entry.plan.forks[entry.atStart ? "start" : "end"] = { offset, vx: sx + rx * offset, vy: sy + ry * offset, trunk: trunkPlan.id, total: width, width: (max - min + 1) * lw, relations: rels.map((r) => r.id), ownWidth: entry.width, neighbours: neighboursOf(item), hx: trunk.hx, hy: trunk.hy };
      (entry.plan.forkPeers ??= new Set()).add(trunkPlan.id);
      (trunkPlan.forkPeers ??= new Set()).add(entry.plan.id);
      const span = min === max ? `pas ${min}` : `pasy ${min}–${max}`;
      entry.plan.provenance.connectivity = {
        value: `${span} jezdni ${trunkPlan.id} w węźle n${node}`,
        source: rels.length ? rels.map((r) => `relacja connectivity r${r.id}: connectivity=${r.tags.connectivity}`).join("; ") : "pozostałe pasy pnia przy węźle z relacją connectivity (wywnioskowane)",
        approximate: !rels.length,
      };
    }
    trunkPlan.forkTotal ??= {};
    trunkPlan.forkTotal[trunk.atStart ? "start" : "end"] = width;
    (trunkPlan.forkLanes ??= {})[trunk.atStart ? "start" : "end"] = trunkLanes.count;
    (trunkPlan.forkHeading ??= {})[trunk.atStart ? "start" : "end"] = [trunk.hx, trunk.hy];
  }
  return { handled, issues };
}
