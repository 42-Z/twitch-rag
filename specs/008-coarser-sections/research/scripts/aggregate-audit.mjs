// Сводка слепой проверки (T018): доли «верно / неверно / нет» по версиям, ошибки по типам и тяжести,
// полезность, место в ранжировании, попарно по окнам. Соответствие букв версиям читается из `key/`.
//
//   node specs/008-coarser-sections/research/scripts/aggregate-audit.mjs [--old lbase] [--new lnew008] [--packets <каталог>]
//
// `--packets` — тот же каталог, что у `build-audit-packets.mjs --packets`; без него — `data/audit/packets/`.
// Ключ (`key/`) читается из `data/audit/key/`, поэтому перед новым прогоном каталог `data/audit` стоит сохранить.
//
// Пороги SC-006 для нового варианта: верных фактов не ниже 77,3 %, отсутствующих не выше 14 %,
// тяжёлых ошибок не больше шести.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };
const OLD = flag("old", "lbase");
const NEW = flag("new", "lnew008");
const PACKETS = flag("packets");

const here = (path) => new URL(path, import.meta.url);
const { windows } = JSON.parse(readFileSync(here("../windows.json"), "utf8"));

const MARKS = { верно: "верно", неверно: "неверно", искажено: "неверно", нет: "нет" };
const newTotals = () => ({ facts: 0, верно: 0, неверно: 0, нет: 0, errors: {}, severe: 0, usefulness: [], wins: 0, windows: 0 });
const totals = { [OLD]: newTotals(), [NEW]: newTotals() };
const rows = [];
const problems = [];

for (const w of windows) {
  const resultFile = PACKETS === undefined ? here(`../data/audit/packets/${w.id}/result.json`) : pathToFileURL(`${PACKETS.replace(/\/$/, "")}/${w.id}/result.json`);
  const keyFile = here(`../data/audit/key/${w.id}.json`);
  if (!existsSync(resultFile)) {
    problems.push(`${w.id}: нет result.json`);
    continue;
  }
  let result;
  try {
    result = JSON.parse(readFileSync(resultFile, "utf8"));
  } catch (error) {
    problems.push(`${w.id}: result.json не читается — ${error.message}`);
    continue;
  }
  const key = JSON.parse(readFileSync(keyFile, "utf8"));
  const row = { window: w.id };
  for (const letter of ["A", "B"]) {
    const tag = key[letter];
    const version = result.versions?.[letter];
    if (version === undefined) {
      problems.push(`${w.id}: нет версии ${letter}`);
      continue;
    }
    const t = totals[tag];
    const counts = { верно: 0, неверно: 0, нет: 0 };
    for (const fact of result.facts ?? []) {
      const mark = MARKS[version.marks?.[String(fact.id)]];
      if (mark === undefined) {
        problems.push(`${w.id} ${letter}: нет отметки по факту ${fact.id}`);
        continue;
      }
      counts[mark] += 1;
    }
    const facts = counts.верно + counts.неверно + counts.нет;
    t.facts += facts;
    t.верно += counts.верно;
    t.неверно += counts.неверно;
    t.нет += counts.нет;
    t.windows += 1;
    for (const error of version.errors ?? []) {
      t.errors[error.type] = (t.errors[error.type] ?? 0) + 1;
      if (error.severity === "тяжёлая") t.severe += 1;
    }
    if (typeof version.usefulness === "number") t.usefulness.push(version.usefulness);
    row[tag] = {
      facts,
      верно: counts.верно,
      нет: counts.нет,
      errors: (version.errors ?? []).length,
      severe: (version.errors ?? []).filter((e) => e.severity === "тяжёлая").length,
      usefulness: version.usefulness,
    };
  }
  const first = result.ranking?.[0];
  if (first !== undefined && key[first] !== undefined) {
    totals[key[first]].wins += 1;
    row.first = key[first];
  }
  rows.push(row);
}

const pct = (n, d) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)} %`);
const mean = (a) => (a.length === 0 ? "—" : (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2));

console.log(`Окон с результатом: ${rows.length} из ${windows.length}`);
for (const p of problems) console.log("  !", p);
for (const tag of [OLD, NEW]) {
  const t = totals[tag];
  console.log(`\n== ${tag} (окон ${t.windows}, фактов ${t.facts}) ==`);
  console.log(`верно ${t.верно} (${pct(t.верно, t.facts)}), неверно ${t.неверно} (${pct(t.неверно, t.facts)}), нет ${t.нет} (${pct(t.нет, t.facts)})`);
  console.log(`ошибок по типам: ${JSON.stringify(t.errors)}, всего ${Object.values(t.errors).reduce((x, y) => x + y, 0)}, тяжёлых ${t.severe}`);
  console.log(`полезность: средняя ${mean(t.usefulness)}; первое место в ранжировании: ${t.wins}`);
}

console.log("\nПо окнам (старый → новый): верно, нет, ошибок (тяжёлых), полезность; первым поставлен");
for (const r of rows) {
  const f = (x) => (x === undefined ? "—" : `${x.верно}/${x.facts} нет ${x.нет}, ош. ${x.errors} (${x.severe}), пол. ${x.usefulness}`);
  console.log(`${r.window.padEnd(16)} ${OLD}: ${f(r[OLD])} | ${NEW}: ${f(r[NEW])} | первым: ${r.first ?? "—"}`);
}

const n = totals[NEW];
const verdict = {
  верно: pct(n.верно, n.facts),
  нет: pct(n.нет, n.facts),
  тяжёлых: n.severe,
  проходит: n.facts > 0 && n.верно / n.facts >= 0.773 && n.нет / n.facts <= 0.14 && n.severe <= 6,
};
console.log("\nSC-006 (новый вариант):", JSON.stringify(verdict));
writeFileSync(here("../data/audit/summary.json"), `${JSON.stringify({ totals, rows, problems, verdict }, null, 2)}\n`);
