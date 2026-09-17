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
   * Управляющее действие над трансляцией. Отказ приходит телом контракта, и
   * текст из него показывается человеку: у отказа может быть своя причина —
   * «разбор уже идёт», — которую по коду состояния не угадать.
   */
  async function act(vodId: string, action: "remove" | "reparse"): Promise<void> {
    const path =
      action === "remove"
        ? `/api/streams/${encodeURIComponent(vodId)}`
        : `/api/streams/${encodeURIComponent(vodId)}/reparse`;
    const response = await fetch(path, {
      method: action === "remove" ? "DELETE" : "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: { message: string } };
      const fallback = action === "remove" ? "Удаление не прошло" : "Повторный разбор не запустился";
      throw new Error(data.error?.message ?? `${fallback} (код ${response.status}).`);
    }
    onChanged();
  }

  return (
    <StreamList
      onOpen={(id) => navigate(knowledgeDocumentPath(id))}
      {...(canManage
        ? {
            onDelete: (id: string) => act(id, "remove"),
            onReparse: (id: string) => act(id, "reparse"),
          }
        : {})}
      refreshToken={refreshToken}
    />
  );
}
