// Пакеты слепой проверки (T016): на окно — эталонная расшифровка, кадры и две версии документа под
// случайными буквами A и B; соответствие букв лежит отдельно от пакетов, чтобы проверяющий его не видел.
//
//   node specs/008-coarser-sections/research/scripts/build-audit-packets.mjs [--old lbase] [--new lnew008] [--seed 20261011] [--packets <каталог>]
//
// Читает: windows.json (12 окон), расшифровки `transcript-<окно>-ru.txt` из данных `002`, кадры и документы
// `document-frames-<окно>-<метка>-frames.json` из данных `007`.
// Пишет в `specs/008-coarser-sections/research/data/audit/` (в `.gitignore`: речь эфира и ники):
//   packets/INSTRUCTIONS.md         — инструкция проверяющему (шаблон audit-instructions.md)
//   packets/<окно>/                 — transcript.txt, frames/, A.md, B.md; сюда проверяющий пишет result.json
//                                     (`--packets <каталог>` кладёт пакеты в другое место — путь с названием
//                                     спецификации подсказывает проверяющему цель опыта, нейтральный путь не подсказывает)
//   key/<окно>.json                 — какая буква какой версии (не показывать проверяющим)
//   tasks/<окно>.txt                — текст задачи проверяющему
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };
const OLD = flag("old", "lbase");
const NEW = flag("new", "lnew008");
const SEED = Number(flag("seed", "20261011"));
const PACKETS = flag("packets");

const here = (path) => new URL(path, import.meta.url);
const transcriptDir = here("../../../002-document-quality/research/data/");
const standDir = here("../../../007-stream-frames/research/data/");
const root = here("../data/audit/");

// Детерминированный генератор: один и тот же порядок букв при каждом запуске с тем же зерном.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hms = (s) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

function versionText(sections) {
  return [...sections]
    .sort((a, b) => a.startSeconds - b.startSeconds)
    .map((s) => `## ${s.title} [${hms(s.startSeconds)} — ${hms(s.endSeconds)}]\n\n${s.text.trim()}\n`)
    .join("\n");
}

const { windows } = JSON.parse(readFileSync(here("../windows.json"), "utf8"));
const packetsRoot = PACKETS === undefined ? new URL("packets/", root) : pathToFileURL(`${PACKETS.replace(/\/$/, "")}/`);
mkdirSync(packetsRoot, { recursive: true });
mkdirSync(new URL("key/", root), { recursive: true });
mkdirSync(new URL("tasks/", root), { recursive: true });
copyFileSync(here("audit-instructions.md"), new URL("INSTRUCTIONS.md", packetsRoot));

const rand = mulberry32(SEED);
for (const w of windows) {
  const k = `${w.vod}-${w.from}-${w.to}`;
  const old = JSON.parse(readFileSync(new URL(`document-frames-${k}-${OLD}-frames.json`, standDir), "utf8"));
  const fresh = JSON.parse(readFileSync(new URL(`document-frames-${k}-${NEW}-frames.json`, standDir), "utf8"));
  const swap = rand() < 0.5;
  const letters = swap ? { A: NEW, B: OLD } : { A: OLD, B: NEW };
  const docs = { [OLD]: old, [NEW]: fresh };

  const dir = new URL(`${w.id}/`, packetsRoot);
  mkdirSync(new URL("frames/", dir), { recursive: true });
  writeFileSync(new URL("transcript.txt", dir), readFileSync(new URL(`transcript-${k}-ru.txt`, transcriptDir), "utf8"));
  const frameDir = new URL(`frames-${k}/`, standDir);
  for (const name of readdirSync(frameDir)) {
    if (/^frame-\d+\.jpg$/.test(name)) copyFileSync(new URL(name, frameDir), new URL(`frames/${name}`, dir));
  }
  for (const [letter, tag] of Object.entries(letters)) {
    writeFileSync(new URL(`${letter}.md`, dir), versionText(docs[tag].sections));
  }
  writeFileSync(new URL(`key/${w.id}.json`, root), `${JSON.stringify({ window: w.id, ...letters })}\n`);
  writeFileSync(
    new URL(`tasks/${w.id}.txt`, root),
    `Слепая проверка. Пакет: ${fileURLToPath(dir)}\nОкно проверки: секунды ${w.from}–${w.to} (id окна: ${w.id}).\n` +
      `Инструкция: ${fileURLToPath(new URL("INSTRUCTIONS.md", packetsRoot))} — прочитай её целиком и выполни. ` +
      `Результат запиши в ${fileURLToPath(new URL("result.json", dir))}.\n`,
  );
  console.log(w.id.padEnd(16), `A=${letters.A}`, `B=${letters.B}`, `разделов: A ${docs[letters.A].sections.length}, B ${docs[letters.B].sections.length}`);
}
console.log("\nпакеты:", fileURLToPath(packetsRoot));
