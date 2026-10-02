/**
 * Временное при разборе: куски аудио, текст расшифровки и кадры эфира в
 * хранилище аудио.
 *
 * Живёт от начала разбора до его конца и не должно пережить его при любом
 * исходе. Объекты одной записи лежат под `<префикс><streamId>/`: слэш после
 * идентификатора отделяет `audio/123/` от `audio/123-p2/`, поэтому уборка
 * одной части соседнюю не задевает.
 *
 * Кадры кладёт программа конвейера в боксе (`pipeline/publish.ts`), а убирает
 * Worker: подписанная ссылка на кадр живёт шесть часов, но объект после
 * разбора никому не нужен — в нём лица и ники зрителей.
 */

import { FRAMES_PREFIX } from "../shared/frames.ts";
import { requireStreamId } from "../shared/stream-id.ts";

/** Временное при разборе: куски аудио, текст расшифровки и кадры эфира. */
export const TEMPORARY_PREFIXES = ["audio/", "transcript/", FRAMES_PREFIX] as const;

/**
 * Уборка по префиксам: после разбора в хранилище не должно остаться ничего из
 * временного — ни целой записи, ни по частям.
 *
 * Идентификатор проверяется до обращения к хранилищу: пустая строка дала бы
 * префикс `audio/` и снесла бы аудио всех записей сразу.
 */
async function removeUnder(bucket: R2Bucket, streamId: string, prefixes: readonly string[]): Promise<void> {
  requireStreamId(streamId);
  for (const prefix of prefixes) {
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

/** Всё временное записи: куски аудио, расшифровка и кадры. */
export async function removeTemporary(bucket: R2Bucket, streamId: string): Promise<void> {
  await removeUnder(bucket, streamId, TEMPORARY_PREFIXES);
}

/**
 * Только кадры записи. Нужна на сбое разбора: аудио и расшифровка остаются —
 * проходы составления без кадров не переигрываются, — а новый заход бокса
 * положит кадры заново.
 */
export async function removeFrames(bucket: R2Bucket, streamId: string): Promise<void> {
  await removeUnder(bucket, streamId, [FRAMES_PREFIX]);
}
