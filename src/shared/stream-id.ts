/**
 * Идентификатор записи реестра.
 *
 * Запись перестаёт совпадать с записью площадки один к одному: эфир длиннее
 * порога делится на части (`stream-parts.ts`), и каждая часть — отдельная
 * запись со своим документом. Поэтому два понятия, прежде слитые в `vodId`,
 * расходятся:
 *
 * - `streamId` — запись реестра: ключ реестра, имя объекта документа, префикс
 *   векторов, адрес страницы, имя прогона разбора;
 * - `vodId` — номер записи на площадке: по нему идут обращения к Twitch и
 *   строятся ссылки на момент эфира.
 *
 * Вид: `<vodId>` у неделёного эфира, `<vodId>-p<номер части>` у части,
 * нумерация с единицы. Разделитель — дефис: имя экземпляра Workflow обязано
 * подходить под `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` (двоеточие и точка нельзя), а
 * длиной — до 100 символов ([документация Workflows](https://developers.cloudflare.com/workflows/reference/limits/)).
 *
 * Собирается и разбирается только здесь: склеивать строку по месту нельзя.
 */

import { AppError } from "./errors.ts";

/**
 * Значение уходит в командную оболочку бокса, в имя файла журнала, в имя
 * объекта хранилища и в префикс удаления векторов. Образец поэтому расширен
 * ровно на суффикс части — дефис, буква `p`, цифры — и ни на что больше.
 */
export const STREAM_ID_PATTERN = /^\d{1,20}(-p\d{1,3})?$/;

export interface ParsedStreamId {
  /** Номер записи на площадке. */
  vodId: string;
  /** Номер части, с единицы; у неделёной записи ключа нет. */
  part?: number;
}

export function isStreamId(value: string): boolean {
  return STREAM_ID_PATTERN.test(value) && !/-p0+$/.test(value);
}

export function formatStreamId(vodId: string, part?: number): string {
  if (part === undefined) return requireStreamId(vodId);
  if (!Number.isInteger(part) || part < 1) {
    throw new AppError("invalid_input", "Номер части эфира — целое число от единицы.");
  }
  return requireStreamId(`${vodId}-p${part}`);
}

export function parseStreamId(value: string): ParsedStreamId {
  const id = requireStreamId(value);
  const separator = id.indexOf("-p");
  if (separator === -1) return { vodId: id };
  return { vodId: id.slice(0, separator), part: Number(id.slice(separator + 2)) };
}

/** Строка, прошедшая проверку, или ошибка «неверный вход» — до обращения к любому хранилищу. */
export function requireStreamId(value: string): string {
  if (!isStreamId(value)) {
    throw new AppError("invalid_input", "Неверный идентификатор записи.", {
      hint: "Идентификатор — номер записи Twitch, у части эфира с суффиксом «-p2».",
    });
  }
  return value;
}
