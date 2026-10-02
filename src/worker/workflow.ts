/**
 * Разбор записи: распознать → составить документ → дать имя → проиндексировать.
 *
 * Оформлено шагами с независимыми повторами, а не одним длинным вызовом:
 * у шестичасовой части (наибольшей из возможных) восемнадцать кусков по
 * двадцать минут, и один вызов не прошёл бы по процессорному времени. При
 * сбое переигрывается шаг, а не весь эфир. Число внешних обращений на весь
 * прогон ограничено пятьюдесятью — отсюда и деление длинного эфира на части
 * (`shared/stream-parts.ts`): разбирается одна часть, а не весь эфир.
 *
 * Время внутри части абсолютное, от начала эфира: метки кусков приходят из
 * конвейера уже такими, и Worker их не сдвигает.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, IngestParams, Services } from "./env.ts";
import { createServices } from "./env.ts";
import { shiftSegments, prevailingLanguage, formatDuration } from "../shared/time.ts";
import { renderTranscript } from "../shared/openrouter.ts";
import { planDocumentParts, assignCategories, uniqueCategories, findCoverageGaps } from "../shared/categories.ts";
import { withPartLabel } from "../shared/document-name.ts";
import { normalizeSections, type ParsedSection } from "../shared/sections.ts";
import { buildChunks } from "../shared/chunks.ts";
import { renderDocumentHeader, Documents } from "../shared/documents.ts";
import { chunkId } from "../shared/knowledge.ts";
import { composePart, composePasses } from "../shared/document-parts.ts";
import { composeReason, formatFramelessNote, framelessSeconds, minPassesForFrames } from "../shared/frames.ts";
import { removeTemporary } from "./temporary.ts";

/**
 * Сколько знаков расшифровки приходится на один проход.
 *
 * Значение выбрано замером, а не по запасу потолка: доля сказанного, которая
 * доходит до документа, падает с ростом прохода — на семидесяти минутах эфира
 * это 51 % и восемь потерянных мест, на сорока 68 % и ни одной потери, на
 * тридцати 64 % и ниже уже не растёт. Потолок выхода тут ни при чём: расход
 * прохода — тысячи токенов из девятисот тысяч возможных, ограничивает не он,
 * а склонность модели сжимать тем сильнее, чем больше перед ней текста.
 *
 * Плата за мельче — вдвое больше вызовов модели и швов между проходами;
 * вызов стоит доли цента, а швы приходятся на смену темы.
 */
const CHARS_PER_PART = 30000;
/** Сколько кусков идёт в одно обращение за эмбеддингами. */
const EMBED_BATCH = 32;

/** Текст распознанного куска: живёт от распознавания до конца разбора. */
const transcriptKey = (streamId: string, index: number): string =>
  `transcript/${streamId}/chunk-${String(index).padStart(4, "0")}.txt`;

/** Склеенная расшифровка всего эфира — то, что видят проходы составления. */
const transcriptFullKey = (streamId: string): string => `transcript/${streamId}/full.txt`;

/**
 * Что владелец видит вместо причины отказа.
 *
 * Фраза стоит здесь, а не собирается из случившегося, потому что причина
 * сбоя наружу не идёт вовсе: она остаётся в журнале. Пока запись в отказе,
 * её берут заново — а когда попытки исчерпаются, причину заменит запись о
 * пропуске (schedule.ts).
 */
const FAILURE_REASON = "Разбор не удался. Запись попробуют разобрать заново.";

export class StreamIngestWorkflow extends WorkflowEntrypoint<Env, IngestParams> {
  override async run(event: Readonly<WorkflowEvent<IngestParams>>, step: WorkflowStep): Promise<void> {
    const params = event.payload;
    const services = createServices(this.env);

    try {
      await this.process(params, step, services);
    } catch (error) {
      // Куски, ещё не распознанные, остаются в хранилище при любом исходе:
      // уборка отсюда убила бы именно ту переигровку, ради которой шаги и
      // разбиты по кускам. Забытое подчищает почасовая уборка по возрасту
      // (`cleanupStaleAudio` в index.ts).
      const message = error instanceof Error ? error.message : String(error);
      // Причина сбоя уходит в журнал и только туда: в реестр она не пишется,
      // а реестр читается публичным токеном — текст ошибки увидел бы любой
      // посетитель страницы.
      console.error(`[разбор ${params.streamId}] ${message}`);
      if (!isEngineReset(message) && !(await isAlreadyFinished(params.streamId, services))) {
        // Запись не должна остаться в processing навсегда — её возьмут заново
        // на следующем опросе (schedule.ts проверяет attempts).
        await services.registry.patchStream(params.streamId, {
          status: "failed",
          reason: FAILURE_REASON,
        });
      }
      throw error;
    }
  }

  private async process(params: IngestParams, step: WorkflowStep, services: Services): Promise<void> {
    // --- распознавание ---
    // Шаг на кусок: отказ переигрывает один кусок, а не весь эфир.
    // Удаление куска — отдельный шаг: если распознавание переиграется после
    // сбоя между выполнением и фиксацией шага (например, сброса Durable
    // Object при деплое), кусок в хранилище всё ещё на месте. `R2.delete`
    // отсутствующего ключа не ошибка, так что сам шаг удаления безопасно
    // повторить.
    const languages: string[] = [];
    // Сколько фраз нашлось в каждом куске: по нулю видно, что текста для него
    // в хранилище и не должно быть.
    const phrasesPerChunk: number[] = [];
    let phraseCount = 0;
    let speechSeconds = 0;

    for (const chunk of params.chunks) {
      const result = await step.do(`распознать кусок ${chunk.index}`, async () => {
        const object = await this.env.AUDIO.get(chunk.key);
        if (object === null) throw new Error(`кусок ${chunk.key} исчез из хранилища`);

        const audio = await object.arrayBuffer();
        // Язык не подсказывается: эфир открывается музыкой или тишиной, на
        // которых распознавание ошибается, а навязанный язык портит все
        // следующие куски — русская речь возвращалась английской абракадаброй.
        const transcription = await services.models.transcribe(audio, {
          filename: `chunk-${chunk.index}.m4a`,
        });

        const segments = shiftSegments(transcription.segments, chunk.offsetSeconds);
        // Текст расшифровки уходит в хранилище, а не в результат шага.
        // Результаты шагов лежат в состоянии экземпляра, которое площадка
        // держит три дня после разбора, а расшифровка не должна переживать
        // разбор (FR-010). Возвращается только счёт: он крохотный и без
        // самого текста ничего не выдаёт.
        const text = renderTranscript(segments);
        if (text !== "") {
          await this.env.AUDIO.put(transcriptKey(params.streamId, chunk.index), text, {
            httpMetadata: { contentType: "text/plain; charset=utf-8" },
          });
        }

        return {
          language: transcription.language,
          phrases: segments.length,
          speechSeconds: Math.round(segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0)),
        };
      });

      await step.do(`удалить кусок ${chunk.index}`, async () => {
        await this.env.AUDIO.delete(chunk.key);
      });

      languages.push(result.language);
      phrasesPerChunk.push(result.phrases);
      phraseCount += result.phrases;
      speechSeconds += result.speechSeconds;
    }

    // Язык эфира — тот, на котором говорят в большинстве кусков, а не тот,
    // что выпал на первом.
    const language = prevailingLanguage(languages);

    if (phraseCount === 0) {
      await step.do("отметить эфир без речи", async () => {
        await services.registry.patchStream(params.streamId, {
          status: "skipped",
          reason: "В записи не распознано ни одной фразы.",
          processedAt: nowUnix(),
        });
        await removeTemporary(this.env.AUDIO, params.streamId);
      });
      return;
    }

    // Куски склеиваются в один текст отдельным шагом: каждому проходу
    // составления нужна расшифровка целиком, а держать её в состоянии
    // экземпляра нельзя. Читаются они по порядку — он же порядок эфира.
    const transcriptChars = await step.do("склеить расшифровку", async () => {
      const parts: string[] = [];
      for (const [position, chunk] of params.chunks.entries()) {
        // В куске без речи текста нет и быть не должно — это не пропажа.
        if (phrasesPerChunk[position] === 0) continue;
        const object = await this.env.AUDIO.get(transcriptKey(params.streamId, chunk.index));
        if (object === null) throw new Error(`расшифровка куска ${chunk.index} исчезла из хранилища`);
        parts.push(await object.text());
      }
      // Куски без речи дают пустую строку: в тексте им делать нечего, иначе
      // на месте музыки и тишины появились бы пустые абзацы, которых в
      // расшифровке целиком не было.
      const text = parts.filter((part) => part !== "").join("\n");
      await this.env.AUDIO.put(transcriptFullKey(params.streamId), text, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      });
      return text.length;
    });

    // Сведения о стримере читаются один раз на разбор: они уходят в системную
    // инструкцию каждого прохода, и брать их заново незачем (FR-015).
    const streamerInfo = await step.do("прочитать сведения о стримере", async () => {
      return (await services.registry.getChannel())?.streamerInfo ?? "";
    });

    // --- составление документа ---
    // В каждом проходе модель получает расшифровку целиком, но пишет только
    // свой участок: иначе отсылки внутри эфира теряют смысл.
    // Проходов не меньше, чем нужно по кадрам: у эфира с редкой речью на проход
    // иначе пришлось бы больше картинок, чем принимает запрос (`shared/frames.ts`).
    // Ссылки на кадры живут в параметрах экземпляра и в результаты шагов не идут.
    const frames = params.frames ?? [];
    const partCount = Math.max(1, Math.ceil(transcriptChars / CHARS_PER_PART), minPassesForFrames(frames.length));
    // Отрезок эфира, который разбирает этот прогон: у части — не от нуля.
    const range = {
      startSeconds: params.partStartSeconds,
      endSeconds: params.partStartSeconds + params.durationSeconds,
    };
    const parts = planDocumentParts(range, params.categories, partCount);

    // Шаг называется иначе, чем до кадров («написать часть»): результат шага
    // теперь не список разделов, а разделы с участками без кадров. Разбор,
    // идущий в момент выпуска, не должен подхватить прежний результат под
    // новым видом — его проходы просто составятся заново.
    const composed = await composePasses({
      parts,
      frames,
      stepName: (index, count) => `составить часть ${index + 1} из ${count}`,
      step: (name, run) => step.do(name, run),
      compose: async ({ part, frames: passFrames, fallbacksLeft }) => {
        const object = await this.env.AUDIO.get(transcriptFullKey(params.streamId));
        if (object === null) throw new Error("склеенная расшифровка исчезла из хранилища");
        return await composePart(
          services.models,
          {
            transcript: await object.text(),
            part,
            publishedAt: params.publishedAt,
            categories: params.categories,
            streamerInfo,
            frames: passFrames,
            // Ключ закрепления за провайдером на всю запись: проходы одной
            // записи должны попадать на тот же узел, иначе кэш входа не сработает.
            sessionId: params.streamId,
          },
          { fallbacksLeft },
        );
      },
    });
    const written: ParsedSection[] = composed.sections.map((section) => ({ ...section, category: "" }));

    // --- разделы ---
    // Не шагом. Результат шага площадка хранит в состоянии экземпляра, и его
    // размер ограничен мегабайтом: здесь же в руках оказывается документ
    // целиком, а на очень длинном эфире он к этому пределу подходит. Работа
    // эта чистая и упасть не может — ей нечего повторять, — а переменные
    // прогона при переигровке восстанавливаются из результатов шагов выше, и
    // в состояние ничего лишнего не ложится.
    const ordered = [...written].sort((a, b) => a.startSeconds - b.startSeconds);
    const sections = assignCategories(normalizeSections(ordered), params.categories);
    if (sections.length === 0) {
      throw new Error("после приведения не осталось ни одного раздела");
    }

    const gaps = findCoverageGaps(sections, range);
    if (gaps.length > 0) {
      // Разрыв во времени означает пропущенный кусок эфира. Документ всё
      // равно сохраняется — терять разобранное из-за дыры нельзя, — но
      // изъян попадает в реестр, а не остаётся незамеченным (FR-040).
      console.warn(`разрывы покрытия по ${params.streamId}: ${JSON.stringify(gaps)}`);
    }

    // --- имя документа ---
    // Отдельным запросом по оглавлению (FR-041): имя нужно и в шапке
    // документа, и в метаданных кусков, и в реестре, поэтому вырабатывается
    // до индексации. Заголовок с площадки в запрос не идёт вовсе (FR-027).
    const docTitle = await step.do("выработать имя документа", async () => {
      const name = await services.models.composeDocumentName({
        publishedAt: params.publishedAt,
        sectionTitles: sections.map((section) => section.title),
        sessionId: params.streamId,
      });
      // Имя части называет часть (FR-005): метка ставится здесь, в коде.
      return withPartLabel(name, params.part);
    });

    // --- индексация ---
    const chunksToIndex = buildChunks({
      sections,
      stream: { streamId: params.streamId, vodId: params.vodId, publishedAt: params.publishedAt },
      language,
      docTitle,
    });

    for (let offset = 0; offset < chunksToIndex.length; offset += EMBED_BATCH) {
      const batch = chunksToIndex.slice(offset, offset + EMBED_BATCH);
      await step.do(`проиндексировать куски ${offset + 1}–${offset + batch.length}`, async () => {
        const vectors = await services.models.embed(batch.map((chunk) => chunk.data));
        await services.knowledge.upsert(
          batch.map((chunk, index) => ({ ...chunk, vector: vectors[index] ?? [] })),
        );
        return batch.length;
      });
    }

    // Повторный разбор делит эфир на разделы заново, и куски прошлого разбора
    // не обязательно перезаписываются: их номера могут не совпасть. Новые
    // куски к этому моменту уже записаны, и убираются только те прежние,
    // которых среди них нет: снести всё перед записью значило бы оставить
    // трансляцию без знаний, если повтор не удастся (FR-032).
    await step.do("убрать куски прошлого разбора", async () => {
      const fresh = new Set(
        chunksToIndex.map((chunk) => chunkId(chunk.streamId, chunk.sectionIndex, chunk.chunkIndex)),
      );
      return await services.knowledge.removeExcept(params.streamId, fresh);
    });

    // --- документ и реестр ---
    // Состояние `ready` выставляется последним действием: до этого момента
    // запись не считается разобранной и будет взята заново.
    await step.do("сохранить документ", async () => {
      const header = renderDocumentHeader({
        name: docTitle,
        publishedAt: params.publishedAt,
        durationSeconds: params.durationSeconds,
        categories: uniqueCategories(params.categories),
      });
      const body = sections
        .map((section) => `## ${section.title} [${formatRange(section)}]\n\n${section.text}`)
        .join("\n\n");
      await services.documents.save(params.streamId, `${header}\n\n${body}\n`);
    });

    await step.do("отметить запись разобранной", async () => {
      await services.registry.patchStream(params.streamId, {
        status: "ready",
        docTitle,
        language,
        sectionCount: sections.length,
        chunkCount: chunksToIndex.length,
        speechSeconds: Math.round(speechSeconds),
        docPath: Documents.path(params.streamId),
        processedAt: nowUnix(),
        // Пометка выставляется всегда, в том числе пустая: иначе на успешно
        // разобранной записи остаётся висеть причина отказа прошлой попытки.
        // В пометке именно длительность: «один участок» может означать и
        // минуту тишины, и четыре часа потерянного эфира.
        // Вторая пометка — сколько эфира документ писался без кадров (FR-015).
        reason: composeReason(
          gaps.length > 0 ? `Разделы не покрывают ${formatGaps(gaps)} эфира.` : "",
          formatFramelessNote(framelessSeconds(range, frames, composed.withoutFrames)),
        ),
      });
    });

    await step.do("убрать временные файлы разбора", async () => {
      await removeTemporary(this.env.AUDIO, params.streamId);
    });
  }
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Разбор уже дошёл до итога — отказом его помечать нельзя.
 *
 * Последним шагом идёт уборка временного аудио, и её сбой (или сбой движка
 * после отметки) прежде затирал `ready` на `failed`. Дальше почасовой опрос
 * видел нерастраченные попытки и запускал разбор заново: повторное
 * скачивание, повторное распознавание за деньги и стирание уже готовых
 * векторов. Готовое должно оставаться готовым.
 */
async function isAlreadyFinished(streamId: string, services: Services): Promise<boolean> {
  const record = await services.registry.getStream(streamId).catch(() => undefined);
  return record?.status === "ready" || record?.status === "skipped";
}

/** «2 ч 14 мин в 3 участках» — столько эфира не попало ни в один раздел. */
export function formatGaps(gaps: ReadonlyArray<{ from: number; to: number }>): string {
  const seconds = gaps.reduce((sum, gap) => sum + (gap.to - gap.from), 0);
  const duration = formatDuration(seconds);
  return gaps.length === 1 ? duration : `${duration} в ${gaps.length} участках`;
}

/**
 * Сбой самого движка, а не разбора: движок переигрывает `run()` с уже
 * пройденных шагов, и работа продолжается. Помечать такую запись отказом
 * нельзя — наблюдалось на живых прогонах, где после «Durable Object reset»
 * разбор доходил до конца, а в реестре всё это время значился отказ.
 *
 * Разбор вправду умрёт, только когда движок исчерпает свои попытки; тогда
 * последней придёт уже не эта ошибка, и запись будет помечена как надо.
 */
function isEngineReset(message: string): boolean {
  return /Durable Object reset|WorkflowInternalError|internal workflows error/i.test(message);
}

function formatRange(section: ParsedSection): string {
  const clock = (seconds: number) => {
    const whole = Math.max(0, Math.floor(seconds));
    const h = Math.floor(whole / 3600);
    const m = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
    const s = String(whole % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  };
  const range = `${clock(section.startSeconds)} — ${clock(section.endSeconds)}`;
  return section.category === "" ? range : `${range} · ${section.category}`;
}
