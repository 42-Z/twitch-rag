/**
 * Проверка 3 (неудавшаяся): можно ли сверять полноту документа без модели.
 *
 * Замысел был такой: обойтись без второго обращения к модели и проверить
 * готовый документ по конкретике из расшифровки — числам и латинским словам.
 * Слова эти не склоняются и не пересказываются синонимами, поэтому проверка
 * вышла бы детерминированной и бесплатной.
 *
 * Не работает. Метрика измеряет не то: перенос мусора распознавания она
 * записывает в полноту, а чистку — в потери. На пятнадцатиминутном участке
 * документ, затащивший в текст 435 латинских слов мусора («really rubbed the»,
 * «makes lot After this battle time»), набрал 96 %, а два других, выбросивших
 * мусор и сохранивших 25 настоящих имён, — 9 и 11 %.
 *
 * Оставлено как запись тупика: сюда не надо возвращаться. Сверять полноту может
 * только смысл, то есть ещё одно обращение к модели поверх расшифровки и
 * документа. Подробнее — в [results.md](../results.md).
 *
 * Запуск:
 *   bun specs/002-document-quality/research/scripts/coverage.ts --transcript 2875806701-1200-5400
 */

import path from "node:path";

const dataDir = path.resolve(import.meta.dir, "..", "data");

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`нужен --${name}`);
  }
  return value;
}

const label = arg("transcript");
const partMinutes = Number(arg("part-minutes", "0"));
const runLabel = partMinutes === 0 ? label : `${label}-part${partMinutes}`;

const lines = (await Bun.file(path.join(dataDir, `transcript-${label}.txt`)).text()).split("\n");
const report = (await Bun.file(path.join(dataDir, `transcript-${label}.json`)).json()) as {
  section: { from: number; to: number };
};

/**
 * Участок прохода: проверяется то, что документ обязан был покрыть. Метки
 * времени в начале строк служебные и в саму проверку не идут.
 */
const partEnd = partMinutes === 0 ? Number.MAX_SAFE_INTEGER : report.section.from + partMinutes * 60;
const source = lines
  .filter((line) => {
    const match = line.match(/^\[(\d+)\]/);
    return match === null || Number(match[1]) <= partEnd;
  })
  .map((line) => line.replace(/^\[\d+\]\s*/, ""))
  .join("\n");

/**
 * Числа и латинские слова, которые обязаны дойти до документа.
 *
 * Отбор — самое слабое место безмодельной проверки, и он же её смысл. Числа
 * берутся только со словом-мерой рядом («300 рублей», «12 тиктоков») или в виде
 * времени: голые числа в расшифровке сплошь обрывки. Латинские слова — только
 * те, что встретились в эфире дважды и больше: имя или название в разговоре
 * повторяется, а мусор распознавания на шуме проходит один раз и должен быть
 * выброшен.
 */
const UNITS = /(руб|тысяч|миллион|час|минут|секунд|зрител|тикток|сери|сезон|год|дн|человек|процент|подписчик|донат)/i;

function specifics(text: string): Map<string, number> {
  const found = new Map<string, number>();
  const add = (raw: string) => found.set(raw, (found.get(raw) ?? 0) + 1);

  for (const line of text.split("\n")) {
    for (const match of line.matchAll(/\d+(?:[.,:]\d+)*/g)) {
      const value = match[0];
      if (value.length < 3 && !UNITS.test(line)) continue;
      if (/^\d{1,2}[.:]\d{2}$/.test(value) || UNITS.test(line)) add(value);
    }
  }
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9'’-]{2,}/g)) add(match[0]);

  return new Map([...found].filter(([value, count]) => /^\d/.test(value) || count >= 2));
}

const items = specifics(source);
const variants = ["A-сегодня", "B-без-потерь", "C-с-объёмом"];

console.log(`конкретики в участке: ${items.size} (числа и латинские слова)`);
console.log(`участок: ${partMinutes === 0 ? "весь" : `${partMinutes} мин`}\n`);

for (const variant of variants) {
  const file = Bun.file(path.join(dataDir, `document-${runLabel}-${variant}.json`));
  if (!(await file.exists())) {
    console.log(`${variant}: нет файла`);
    continue;
  }
  const document = (await file.json()) as { sections: Array<{ text: string; title: string }> };
  const written = document.sections.map((section) => `${section.title}\n${section.text}`).join("\n").toLowerCase();

  const missing: string[] = [];
  for (const item of items.keys()) {
    if (!written.includes(item.toLowerCase())) missing.push(item);
  }
  const kept = items.size - missing.length;
  console.log(
    `${variant}: дошло ${kept} из ${items.size} (${Math.round((kept / items.size) * 100)}%)` +
      (missing.length === 0 ? "" : `\n    потеряно: ${missing.slice(0, 14).join(", ")}`),
  );
}
