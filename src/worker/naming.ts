/**
 * Имена документам, разобранным до того, как документы стали именоваться
 * (FR-022).
 *
 * Имя обязательно у каждого документа, а у записей, разобранных прежним
 * кодом, его нет. Повторный разбор их бы перебрал, но это стоит столько же,
 * сколько первый: запись скачивается и распознаётся заново. Имя же делается по
 * оглавлению готового документа, а оно уже есть, — то есть одним обращением к
 * модели.
 *
 * Отсюда и место: почасовая проверка. Работа разовая — как только имя
 * появилось, запись из неё выпадает, — и новых расходов после себя не
 * оставляет.
 */

import type { Services } from "./env.ts";
import type { StreamRecord } from "../shared/registry.ts";
import { documentName } from "../shared/document-name.ts";
import { documentSectionTitles, renameDocumentHeader } from "../shared/documents.ts";

/**
 * Сколько раз пробовать, прежде чем оставить запись без имени.
 *
 * Именование — обращение к модели, то есть деньги. Без предела запись, у
 * которой имя не выходит по причине, которая сама не пройдёт, платила бы за
 * попытку каждый час и бессрочно. Три попытки — тот же предел, что у разбора,
 * и по той же причине.
 */
const MAX_NAME_ATTEMPTS = 3;

export async function nameDocumentsWithoutNames(
  records: Iterable<StreamRecord>,
  services: Services,
): Promise<number> {
  let named = 0;
  for (const record of records) {
    if (record.status !== "ready" || documentName(record) !== "") continue;
    const tried = record.nameAttempts ?? 0;
    if (tried >= MAX_NAME_ATTEMPTS) continue;
    try {
      await nameOne(record, services);
      named += 1;
    } catch (error) {
      // Неудача именования не повод валить проверку: без имени запись
      // остаётся различимой по дате, а следующая проверка попробует снова —
      // но не бесконечно.
      console.error(`[имя ${record.vodId}] ${error instanceof Error ? error.message : String(error)}`);
      await services.registry
        .patchStream(record.vodId, { nameAttempts: tried + 1 })
        .catch((patchError: unknown) =>
          console.error(`[имя ${record.vodId}] счёт попыток не сохранился: ${String(patchError)}`),
        );
    }
  }
  return named;
}

/**
 * Имя пишется в три места — в документ, в метаданные кусков и в реестр, — и
 * реестр последним.
 *
 * Он же и признак готовности: по нему следующая проверка решает, что делать
 * больше нечего. Запиши его первым, сбой на документе оставил бы имя в списке
 * и прежнее имя в шапке — расхождение, которое само уже не заживёт (FR-025).
 * При обратном порядке сбой приводит лишь к тому, что имя выработается
 * заново, и это дешевле.
 */
async function nameOne(record: StreamRecord, services: Services): Promise<void> {
  const markdown = await services.documents.read(record.vodId);
  const sectionTitles = documentSectionTitles(markdown);
  if (sectionTitles.length === 0) {
    throw new Error("в документе нет ни одного раздела — имени взяться неоткуда.");
  }

  const name = await services.models.composeDocumentName({
    publishedAt: record.publishedAt,
    sectionTitles,
    sessionId: record.vodId,
  });

  await services.documents.save(record.vodId, renameDocumentHeader(markdown, name));
  await services.knowledge.renameStream(record.vodId, name);
  await services.registry.patchStream(record.vodId, { docTitle: name });
}
