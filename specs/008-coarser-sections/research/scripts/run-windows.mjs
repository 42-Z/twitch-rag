// Прогон стенда по 12 окнам слепой проверки с заданной меткой: по одному процессу `measure-frames.ts` на окно,
// несколько окон одновременно.
//
//   node --env-file=.env specs/008-coarser-sections/research/scripts/run-windows.mjs <метка> [одновременно=4]
//
// Те же расшифровки (`transcript-<окно>.txt` без `-ru`), кадры и сведения о стримере, что у прогонов `lbase` и
// `lnew008`; платный: цена каждого окна — в `record.costUsd` файла `document-frames-<окно>-<метка>-frames.json`.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [tag, parallelArg] = process.argv.slice(2);
if (tag === undefined) {
  console.error("Укажите метку прогона");
  process.exit(1);
}
const parallel = Number(parallelArg ?? 4);
const here = (path) => new URL(path, import.meta.url);
const standScript = fileURLToPath(here("../../../007-stream-frames/research/scripts/measure-frames.ts"));
const infoFile = fileURLToPath(here("../data/streamer-info.md"));
const standData = here("../../../007-stream-frames/research/data/");
const { windows } = JSON.parse(readFileSync(here("../windows.json"), "utf8"));

const queue = windows.map((w) => `${w.vod}-${w.from}-${w.to}`);
const results = new Map();

function run(label) {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      [standScript, "--transcript", label, "--frames", label, "--tag", tag, "--variants", "frames", "--streamer-info-file", infoFile],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    let tail = "";
    child.stdout.on("data", (chunk) => { tail = (tail + chunk).slice(-600); });
    child.stderr.on("data", (chunk) => { tail = (tail + chunk).slice(-600); });
    child.on("close", (code) => {
      results.set(label, code);
      console.log(`${new Date().toISOString()} ${label} код ${code}${code === 0 ? "" : `\n${tail}`}`);
      resolve();
    });
  });
}

async function worker() {
  for (;;) {
    const label = queue.shift();
    if (label === undefined) return;
    await run(label);
  }
}

await Promise.all(Array.from({ length: parallel }, worker));

let total = 0;
let sections = 0;
for (const label of results.keys()) {
  try {
    const { record, sections: list } = JSON.parse(readFileSync(new URL(`document-frames-${label}-${tag}-frames.json`, standData), "utf8"));
    total += record.costUsd;
    sections += list.length;
    console.log(label.padEnd(24), `разделов ${list.length}`, `цена ${record.costUsd}`);
  } catch {
    console.log(label.padEnd(24), "файла нет (прогон не закончился)");
  }
}
console.log(`ИТОГО разделов ${sections}, цена $${total.toFixed(6)}`);
