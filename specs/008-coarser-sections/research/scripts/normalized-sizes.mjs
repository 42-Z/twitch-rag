// Размеры разделов стенда до и после боевой склейки коротких (`normalizeSections`).
//
//   node specs/008-coarser-sections/research/scripts/normalized-sizes.mjs
//
// Стенд (`measure-frames.ts`) сохраняет разделы, как их отдала модель. Боевой разбор пропускает их через
// `normalizeSections`: раздел короче 400 знаков приклеивается к предыдущему. Скрипт считает обе величины по одним и
// тем же файлам прогонов, чтобы цифры стенда можно было сравнивать с боевым документом.
import { readFileSync } from "node:fs";
import { normalizeSections } from "../../../../src/shared/sections.ts";

const dataDir = new URL("../../../007-stream-frames/research/data/", import.meta.url);

const FRAGMENTS = ["2875806701-1200-5400", "2872271642-4900-10500", "2872271642-10500-16800"];
const WINDOWS = [
  "2886454832-16260-17460", "2886454832-6240-7440", "2887312281-10380-11580", "2887312281-14880-16080",
  "2888127083-17160-18360", "2888127083-3900-5100", "2889011467-15480-16680", "2889011467-7500-8700",
  "2889891841-11160-12360", "2889891841-3300-4500", "2890802557-12960-14160", "2890802557-6060-7260",
];

/** Группы: подпись, файлы разделов (по одному на фрагмент или окно). */
const GROUPS = [
  { name: "Luna до 008 (s-luna-max), 3 фрагмента", files: FRAGMENTS.map((f) => `document-frames-${f}-s-luna-max-frames.json`) },
  { name: "прежняя модель (run1), 3 фрагмента", files: FRAGMENTS.map((f) => `document-frames-${f}-run1-frames.json`) },
  { name: "v3008, 3 фрагмента", files: FRAGMENTS.map((f) => `document-frames-${f}-v3008-frames.json`) },
  { name: "Luna до 008 (lbase), 12 окон", files: WINDOWS.map((w) => `document-frames-${w}-lbase-frames.json`) },
  { name: "v3008 (lnew008), 12 окон", files: WINDOWS.map((w) => `document-frames-${w}-lnew008-frames.json`) },
];

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const share = (a, f) => (100 * a.filter(f).length) / a.length;

function describe(sections) {
  const sec = sections.map((s) => s.endSeconds - s.startSeconds);
  const chars = sections.map((s) => s.text.length);
  return {
    sections: sections.length,
    meanSec: Math.round(mean(sec)),
    medianSec: Math.round(median(sec)),
    under120: share(sec, (x) => x < 120).toFixed(1),
    meanChars: Math.round(mean(chars)),
    under400chars: share(chars, (x) => x < 400).toFixed(1),
  };
}

for (const group of GROUPS) {
  const raw = [];
  const normalized = [];
  for (const file of group.files) {
    const { sections } = JSON.parse(readFileSync(new URL(file, dataDir), "utf8"));
    const parsed = sections.map((s) => ({
      title: s.title,
      text: s.text,
      startSeconds: s.startSeconds,
      endSeconds: s.endSeconds,
      category: "",
    }));
    raw.push(...parsed);
    normalized.push(...normalizeSections(parsed));
  }
  console.log(`\n${group.name}`);
  console.log("  как отдала модель:    ", JSON.stringify(describe(raw)));
  console.log("  после normalizeSections:", JSON.stringify(describe(normalized)));
}
