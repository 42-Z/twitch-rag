/**
 * Раздел знаний: список разобранного и документ трансляции (FR-029…FR-031).
 *
 * Документ открывается по своему адресу — ссылку на разбор можно передать.
 * Удаление доступно только с верным токеном владельца (FR-037), поэтому
 * кнопка удаления появляется лишь тогда, когда токен принят: подсказок об
 * этом на странице нет, читателю они ничего не меняют.
 */

import { StreamList } from "../components/StreamList.tsx";
import { DocumentView } from "../components/DocumentView.tsx";
import { navigate } from "../lib/router.tsx";
import { knowledgeDocumentPath } from "../lib/routes.ts";
import { ingestOutcome, type IngestOutcome } from "../lib/owner.ts";

interface KnowledgePageProps {
  /** Идентификатор открытого документа, если адрес указывает на него. */
  vodId?: string;
  /** Токен владельца: без него удаление недоступно. */
  adminToken: string;
  canManage: boolean;
  /** Растёт после действий владельца — список перечитывается. */
  refreshToken: number;
  onChanged: () => void;
}

export function KnowledgePage({
  vodId,
  adminToken,
  canManage,
  refreshToken,
  onChanged,
}: KnowledgePageProps): React.JSX.Element {
  if (vodId !== undefined) {
    return <DocumentView vodId={vodId} onClose={() => navigate("/knowledge")} />;
  }

  /**
   * Отказ приходит телом контракта, и текст из него показывается человеку: у
   * отказа может быть своя причина — «разбор уже идёт», — которую по коду
   * состояния не угадать.
   */
  async function refuse(response: Response, fallback: string): Promise<never> {
    const data = (await response.json().catch(() => ({}))) as { error?: { message: string } };
    throw new Error(data.error?.message ?? `${fallback} (код ${response.status}).`);
  }

  async function remove(vodId: string): Promise<void> {
    const response = await fetch(`/api/streams/${encodeURIComponent(vodId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!response.ok) await refuse(response, "Удаление не прошло");
    onChanged();
  }

  /**
   * Повторный разбор отвечает не только «начат»: запись, которую разбирать
   * нечего, он пропускает — и тогда разбора не будет, хотя запрос прошёл.
   * Исход возвращается списку: показать такую запись разбираемой значило бы
   * обещать работу, которой сервис не начал.
   */
  async function reparse(vodId: string): Promise<IngestOutcome> {
    const response = await fetch(`/api/streams/${encodeURIComponent(vodId)}/reparse`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!response.ok) await refuse(response, "Повторный разбор не запустился");
    const answer = (await response.json().catch(() => ({}))) as { status?: string; reason?: string };
    const outcome = ingestOutcome(answer);
    if (outcome.kind === "started") onChanged();
    return outcome;
  }

  return (
    <StreamList
      onOpen={(id) => navigate(knowledgeDocumentPath(id))}
      {...(canManage
        ? {
            onDelete: (id: string) => remove(id),
            onReparse: (id: string) => reparse(id),
          }
        : {})}
      refreshToken={refreshToken}
    />
  );
}
