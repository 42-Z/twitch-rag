/**
 * Показ даты на странице.
 *
 * Отдельным модулем, а не внутри списка: дата нужна и в самом списке, и в
 * подписях кнопок рядом с записью. И только на странице: в Worker тот же
 * показ делается срезом ISO-строки, потому что набор языков у среды
 * исполнения урезан и `toLocaleDateString` там ничего не обещает.
 */

export function formatDate(iso: string): string {
  if (iso === "") return "дата неизвестна";
  return new Date(iso).toLocaleDateString("ru-RU", { year: "numeric", month: "long", day: "numeric" });
}

/**
 * Как запись называется там, где её нужно узнать.
 *
 * Имя документа показывается, когда оно есть; когда его нет — дата эфира.
 * Заголовок с площадки не показывается и здесь (FR-027), а дата различает
 * записи не хуже: одинаковых эфиров в один день у канала не бывает.
 *
 * У части эфира дата одна на все части, и без пометки две строки за один
 * день читались бы как сбой: к дате добавляется «часть N из M». У части с
 * именем пометка уже стоит в самом имени (`withPartLabel`) — повторять её
 * незачем.
 */
export function recordLabel(stream: {
  docTitle?: string;
  publishedAt: string;
  part?: number;
  partCount?: number;
}): string {
  if (stream.docTitle !== undefined && stream.docTitle !== "") return stream.docTitle;
  const date = formatDate(stream.publishedAt);
  return stream.part !== undefined && stream.partCount !== undefined
    ? `${date} · часть ${stream.part} из ${stream.partCount}`
    : date;
}
