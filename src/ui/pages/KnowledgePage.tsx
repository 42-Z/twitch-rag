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

  async function remove(vodId: string): Promise<void> {
    const response = await fetch(`/api/streams/${encodeURIComponent(vodId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: { message: string } };
      throw new Error(data.error?.message ?? `Удаление не прошло (код ${response.status}).`);
    }
    onChanged();
  }

  return (
    <StreamList
      onOpen={(id) => navigate(knowledgeDocumentPath(id))}
      {...(canManage ? { onDelete: remove } : {})}
      refreshToken={refreshToken}
    />
  );
}
