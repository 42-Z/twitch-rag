/**
 * Проверка имени документа на настоящем оглавлении: берём темы разделов из уже
 * состоявшегося прогона и смотрим, какое имя выходит.
 *
 * Отвечает на ту половину сценарной проверки, которую нельзя установить по
 * коду: имя вырабатывает модель, и «осмысленно ли оно» — вопрос к ней, а не к
 * проводке. Вторая половина — совпадает ли имя в шапке документа, в списке и в
 * поисковой выдаче — держится кодом: во все три места идёт одно значение
 * `docTitle`, и это покрыто тестами.
 *
 * Запуск: bun specs/002-document-quality/research/scripts/name-check.ts [файл] [прогонов]
 */

import { OpenRouter } from "../../../../src/shared/openrouter.ts";

const file =
  process.argv[2] ??
  "specs/002-document-quality/research/data/document-2875806701-1200-5400-part40-имена-латиницей-A-со-сведениями-r1.json";
const rounds = Number(process.argv[3] ?? 4);

const parsed = (await Bun.file(file).json()) as {
  sections: { title: string }[];
  record?: { provider?: string };
};

const sectionTitles = parsed.sections.map((section) => section.title);
const apiKey = process.env.OPENROUTER_API_KEY;
if (apiKey === undefined || apiKey === "") throw new Error("нет OPENROUTER_API_KEY");

const openrouter = new OpenRouter(apiKey);
const publishedAt = "2026-09-16T16:54:29Z";

console.log(`Разделов: ${sectionTitles.length}`);
console.log(`Заголовок с площадки: «РАССКАЗЫВАЮ ИСТОРИИ И ЧЁ-ТА ДЕЛАЮ // !донат !приватка !правила !funpay !tornado !тг»\n`);

for (let round = 1; round <= rounds; round += 1) {
  try {
    const name = await openrouter.composeDocumentName({
      publishedAt,
      sectionTitles,
      sessionId: `name-check-${round}`,
    });
    console.log(`${round}. ${name}`);
  } catch (error) {
    console.log(`${round}. ошибка: ${error instanceof Error ? error.message : String(error)}`);
  }
}
