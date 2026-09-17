/**
 * Форма ответа модели: строгая схема документа и имени.
 *
 * Схема описывается один раз здесь и переиспользуется всем, что имеет дело с
 * ответом: боевым разбором и стендом замеров. Так требование «ответ приходит
 * по заранее заданной схеме» (FR-036) перестаёт зависеть от того, кто именно
 * составил запрос.
 *
 * Почему схема, а не просьба «ответь JSON»: строгий режим обязывает модель
 * держать состав полей, а не только синтаксис. Прежний разбор свободного
 * ответа ломался на нестандартной записи времени — одна и та же модель на трёх
 * прогонах выдала `0:47:55`, `0:165` и голые секунды, и каждый раз разбор терял
 * вместе с непонятым заголовком часы эфира.
 *
 * Корень схемы — объект: strict-режим иного не принимает, поэтому и документ,
 * и имя обёрнуты в объект, а не отданы массивом или строкой.
 */

import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";

/** Раздел, каким его обязуется вернуть модель: время — числа секунд, а не текст. */
export const documentSectionSchema = z.object({
  title: z.string().describe("Название темы в несколько слов"),
  text: z.string().describe("Связный текст раздела"),
  startSeconds: z.number().int().describe("Начало раздела в секундах от начала записи"),
  endSeconds: z.number().int().describe("Конец раздела в секундах от начала записи"),
});

/** Документ: разделы по порядку хода эфира. */
export const documentSchema = z.object({
  sections: z.array(documentSectionSchema).describe("Разделы документа по порядку хода эфира"),
});

/** Имя документа: одна фраза, пригодная и человеку, и ассистенту (FR-024). */
export const documentNameSchema = z.object({
  name: z.string().describe("Имя документа одной осмысленной фразой, без эмодзи и хэштегов"),
});

export type ComposedSection = z.infer<typeof documentSectionSchema>;
export type ComposedDocument = z.infer<typeof documentSchema>;

/**
 * Форматы собираются один раз вне цикла проходов: помощник проставляет
 * `strict: true` и `additionalProperties: false`, и делать это на каждый
 * проход незачем.
 */
export const DOCUMENT_RESPONSE_FORMAT = zodResponseFormat(documentSchema, "document");
export const DOCUMENT_NAME_RESPONSE_FORMAT = zodResponseFormat(documentNameSchema, "document_name");
