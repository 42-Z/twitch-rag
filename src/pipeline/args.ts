/**
 * Аргументы запуска прогона.
 *
 * Отдельным модулем, потому что `main.ts` исполняется при импорте и под
 * проверку не подключается, а разбор аргументов — то, на чём держится
 * порядок выпуска: программа кладётся в бокс раньше сервиса, и какое-то время
 * прежний сервис запускает её со старыми аргументами (`--vod`, без границ
 * отрезка). Ошибка разбора случается раньше, чем прогон успевает о чём-либо
 * сообщить, — запись висела бы в «разбирается» сутки. Поэтому прежний вид
 * принимается: `--vod` читается как `--stream`, отсутствующие границы
 * означают весь эфир.
 */

import { parseStreamId } from "../shared/stream-id.ts";

export interface Args {
  /** Запись реестра: `<vodId>` или `<vodId>-p<номер части>`. */
  streamId: string;
  /** Номер записи на площадке. */
  vodId: string;
  url: string;
  callbackUrl: string;
  /** Начало отрезка от начала эфира; нет — с начала. */
  fromSeconds?: number;
  /** Конец отрезка; нет — до конца эфира. */
  toSeconds?: number;
}

export function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length - 1; index++) {
    const key = argv[index];
    if (key !== undefined && key.startsWith("--")) values.set(key.slice(2), argv[index + 1] ?? "");
  }
  const streamId = values.get("stream") ?? values.get("vod") ?? "";
  const url = values.get("url") ?? "";
  const callbackUrl = values.get("callback") ?? "";
  if (streamId === "" || url === "" || callbackUrl === "") {
    throw new Error("нужны --stream (или прежний --vod), --url и --callback");
  }
  // Значение уходит в имя рабочего каталога и в ключи объектов: проверка та же,
  // что у сервиса.
  const { vodId } = parseStreamId(streamId);

  const fromSeconds = optionalSeconds(values.get("from"), "--from");
  const toSeconds = optionalSeconds(values.get("to"), "--to");
  if (fromSeconds !== undefined && toSeconds !== undefined && fromSeconds >= toSeconds) {
    throw new Error("--from должно быть меньше --to");
  }
  return {
    streamId,
    vodId,
    url,
    callbackUrl,
    ...(fromSeconds === undefined ? {} : { fromSeconds }),
    ...(toSeconds === undefined ? {} : { toSeconds }),
  };
}

function optionalSeconds(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,9}$/.test(value)) throw new Error(`${name} — целое число секунд`);
  return Number(value);
}
