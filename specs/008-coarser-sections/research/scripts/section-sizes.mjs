// Размеры разделов: сколько их, какой длины по знакам и по времени.
//
// Боевые документы из Upstash Blob (нужен .env):
//   node --env-file=.env specs/008-coarser-sections/research/scripts/section-sizes.mjs <streamId> ...
// Прогоны стенда — файлы `document-frames-<фрагмент>-<метка>-<вариант>.json` из каталога данных `007`
// (токены не нужны; метка — как в `--tag` стенда, несколько через запятую):
//   node specs/008-coarser-sections/research/scripts/section-sizes.mjs --tag v1008[,v2008] [--variant frames] [--fragments a,b]
//
// Знаки раздела у стенда — длина `text`, у боевого документа — строки под заголовком: счёт близкий, но не
// побайтно один и тот же, поэтому знаки двух режимов друг с другом не сравниваются, секунды — сравниваются.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };
// Три длинных фрагмента, на которых меряется размер (research.md §3): ход боевого прохода они повторяют лучше окон.
const FRAGMENTS = ["2875806701-1200-5400", "2872271642-4900-10500", "2872271642-10500-16800"];
const standDir = new URL("../../../007-stream-frames/research/data/", import.meta.url);
const H = /^## (.+?)\s*\[(\d+):(\d\d):(\d\d)\s*—\s*(\d+):(\d\d):(\d\d)(?:\s*·[^\]]*)?\]\s*$/;

/** Длина фрагмента в секундах по метке `<эфир>-<от>-<до>`; у боевых документов метки времени нет. */
const spanOf = (label) => {
  const m = label.match(/-(\d+)-(\d+)$/);
  return m === null ? undefined : +m[2] - +m[1];
};

/** Строки сводки: `group` — метка прогона стенда или «боевые»; `secs` — размеры разделов; у стенда ещё проходы и цена. */
const rows = [];
const tags = flag("tag");
if (tags !== undefined) {
  const variant = flag("variant") ?? "frames";
  const fragments = flag("fragments")?.split(",") ?? FRAGMENTS;
  for (const tag of tags.split(",")) {
    for (const fragment of fragments) {
      const file = new URL(`document-frames-${fragment}-${tag}-${variant}.json`, standDir);
      const { record, sections } = JSON.parse(readFileSync(file, "utf8"));
      rows.push({
        group: tag,
        id: fragment,
        secs: sections.map((s) => ({ title: s.title, sec: s.endSeconds - s.startSeconds, chars: s.text.length })),
        passes: record.passes?.length,
        // Проход, оборванный провайдером, документа не ломает, но оставляет дыру: без этой отметки прогон
        // выглядит полным, а размеры считаются по неполному покрытию.
        failed: record.passes?.filter((pass) => pass.failure).length ?? 0,
        span: spanOf(fragment),
        cost: record.costUsd,
      });
    }
  }
} else {
  const { Bucket } = await import("@upstash/blob");
  const bucket = new Bucket({ token: process.env.UPSTASH_BLOB_TOKEN });
  mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
  for (const id of args) {
    const d = await bucket.get(`streams/${id}.md`);
    const text = await new Response(d.body).text();
    writeFileSync(new URL(`../data/doc-${id}.md`, import.meta.url), text);
    const secs = [];
    let cur = null;
    for (const line of text.split("\n")) {
      const m = line.match(H);
      if (m) {
        cur = { title: m[1], sec: (+m[5] * 3600 + +m[6] * 60 + +m[7]) - (+m[2] * 3600 + +m[3] * 60 + +m[4]), chars: 0 };
        secs.push(cur);
      } else if (cur) cur.chars += line.length + 1;
    }
    rows.push({ group: "боевые", id, secs });
  }
}

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const mean = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
const share = (a, f) => (100 * a.filter(f).length / a.length).toFixed(1);
const covered = (r) => r.secs.reduce((sum, section) => sum + section.sec, 0);
const price = (x) => (x === undefined ? "" : `, цена $${x.toFixed(6)}`);
for (const group of [...new Set(rows.map((r) => r.group))]) {
  const part = rows.filter((r) => r.group === group);
  console.log(`\n== ${group} ==`);
  for (const r of part) {
    const c = r.secs.map((s) => s.chars), t = r.secs.map((s) => s.sec);
    console.log(
      r.id.padEnd(24),
      `разделов ${r.secs.length}`,
      `секунд: средний ${mean(t)}, медиана ${q(t, .5)}, p10 ${q(t, .1)}, p90 ${q(t, .9)}, короче 120 с ${share(t, (x) => x < 120)} %`,
      `знаков: медиана ${q(c, .5)}, p10 ${q(c, .1)}, p90 ${q(c, .9)}`,
      r.passes === undefined ? "" : `проходов ${r.passes}${price(r.cost)}`,
      r.failed > 0 ? `!!! СБОЕВ ПРОХОДОВ ${r.failed}` : "",
      r.span === undefined || covered(r) === r.span ? "" : `охвачено ${covered(r)} из ${r.span} с`,
    );
  }
  const all = part.flatMap((r) => r.secs);
  const C = all.map((s) => s.chars), T = all.map((s) => s.sec);
  const cost = part.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  console.log(`\nВСЕГО ${group}:`, all.length, "разделов", part[0].passes === undefined ? "" : `, проходов ${part.reduce((n, r) => n + r.passes, 0)}${price(cost)}`);
  console.log("секунд: средний", mean(T), "медиана", q(T, .5), "p10", q(T, .1), "p25", q(T, .25), "p75", q(T, .75), "p90", q(T, .9));
  console.log("знаков: средний", mean(C), "медиана", q(C, .5), "p10", q(C, .1), "p25", q(C, .25), "p75", q(C, .75), "p90", q(C, .9));
  console.log("короче 1 минуты:", share(T, (x) => x < 60), "%; короче 2 минут:", share(T, (x) => x < 120), "%; короче 3 минут:", share(T, (x) => x < 180), "%");
  console.log("короче 600 знаков:", share(C, (x) => x < 600), "%; короче 1000:", share(C, (x) => x < 1000), "%");
}
