/**
 * Временное при разборе: куски аудио и текст расшифровки в хранилище аудио.
 *
 * Живёт от начала разбора до его конца и не должно пережить его при любом
 * исходе. Объекты одной записи лежат под `<префикс><streamId>/`: слэш после
 * идентификатора отделяет `audio/123/` от `audio/123-p2/`, поэтому уборка
 * одной части соседнюю не задевает.
 */

import { requireStreamId } from "../shared/stream-id.ts";

/** Временное при разборе: куски аудио и текст расшифровки. */
export const TEMPORARY_PREFIXES = ["audio/", "transcript/"] as const;

/**
 * Уборка по префиксам: после разбора в хранилище не должно остаться ни кусков
 * записи, ни расшифровки — ни целой, ни по частям.
 *
 * Идентификатор проверяется до обращения к хранилищу: пустая строка дала бы
 * префикс `audio/` и снесла бы аудио всех записей сразу.
 */
export async function removeTemporary(bucket: R2Bucket, streamId: string): Promise<void> {
  requireStreamId(streamId);
  for (const prefix of TEMPORARY_PREFIXES) {
    let cursor: string | undefined;
    do {
      const listed = await bucket.list({
        prefix: `${prefix}${streamId}/`,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (listed.objects.length > 0) {
        await bucket.delete(listed.objects.map((object) => object.key));
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor !== undefined);
  }
}
