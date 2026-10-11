// Размеры разделов в боевых документах: сколько их, какой длины по знакам и по времени.
// Запуск: node --env-file=.env specs/008-coarser-sections/research/scripts/section-sizes.mjs <streamId> ...
import { Bucket } from "@upstash/blob";
import { mkdirSync, writeFileSync } from "node:fs";

const bucket = new Bucket({ token: process.env.UPSTASH_BLOB_TOKEN });
const H = /^## (.+?)\s*\[(\d+):(\d\d):(\d\d)\s*—\s*(\d+):(\d\d):(\d\d)(?:\s*·[^\]]*)?\]\s*$/;
const out = mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
const rows = [];
for (const id of process.argv.slice(2)) {
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
  rows.push({ id, secs });
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const all = rows.flatMap((r) => r.secs);
for (const r of rows) {
  const c = r.secs.map((s) => s.chars), t = r.secs.map((s) => s.sec);
  console.log(r.id.padEnd(15), `разделов ${r.secs.length}`, `знаков: медиана ${q(c, .5)}, p10 ${q(c, .1)}, p90 ${q(c, .9)}`, `секунд: медиана ${q(t, .5)}, p10 ${q(t, .1)}, p90 ${q(t, .9)}`);
}
const C = all.map((s) => s.chars), T = all.map((s) => s.sec);
const share = (a, f) => (100 * a.filter(f).length / a.length).toFixed(1);
console.log("\nВСЕГО", all.length, "разделов");
console.log("знаков: медиана", q(C, .5), "p10", q(C, .1), "p25", q(C, .25), "p75", q(C, .75), "p90", q(C, .9));
console.log("секунд: медиана", q(T, .5), "p10", q(T, .1), "p25", q(T, .25), "p75", q(T, .75), "p90", q(T, .9));
console.log("короче 1 минуты:", share(T, (x) => x < 60), "%; короче 2 минут:", share(T, (x) => x < 120), "%; короче 3 минут:", share(T, (x) => x < 180), "%");
console.log("короче 600 знаков:", share(C, (x) => x < 600), "%; короче 1000:", share(C, (x) => x < 1000), "%");
