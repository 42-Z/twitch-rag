// Боевой документ (markdown из Upstash Blob) → файл разделов в формате стенда, чтобы к нему применялись
// `measure-frames.ts --check` и `normalized-sizes.mjs`.
//
//   node specs/008-coarser-sections/research/scripts/doc-to-stand-json.mjs <документ.md> <метка> <эфир-диапазон>
//   пример: … data/doc-2892792614-before.md live-old 2892792614-0-8387
//
// Результат: `specs/007-stream-frames/research/data/document-frames-<эфир-диапазон>-<метка>-frames.json`.
import { readFileSync, writeFileSync } from "node:fs";

const [docPath, tag, label] = process.argv.slice(2);
if (docPath === undefined || tag === undefined || label === undefined) {
  console.error("Нужны: файл документа, метка, эфир-диапазон");
  process.exit(1);
}

const H = /^## (.+?)\s*\[(\d+):(\d\d):(\d\d)\s*—\s*(\d+):(\d\d):(\d\d)(?:\s*·([^\]]*))?\]\s*$/;
const sections = [];
let current = null;
for (const line of readFileSync(docPath, "utf8").split("\n")) {
  const match = line.match(H);
  if (match) {
    current = {
      title: match[1],
      text: "",
      startSeconds: +match[2] * 3600 + +match[3] * 60 + +match[4],
      endSeconds: +match[5] * 3600 + +match[6] * 60 + +match[7],
      category: (match[8] ?? "").trim(),
    };
    sections.push(current);
  } else if (current !== null) {
    current.text += `${line}\n`;
  }
}
for (const section of sections) section.text = section.text.trim();

const out = new URL(
  `../../../007-stream-frames/research/data/document-frames-${label}-${tag}-frames.json`,
  import.meta.url,
);
writeFileSync(out, `${JSON.stringify({ record: { variant: "frames", label, tag, source: docPath }, sections }, null, 2)}\n`);
console.log(`${sections.length} разделов → ${out.pathname}`);
