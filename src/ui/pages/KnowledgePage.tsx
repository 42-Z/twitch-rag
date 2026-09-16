/**
 * Раздел знаний: список разобранного и документ трансляции (FR-029…FR-031).
 *
 * Документ открывается по своему адресу — ссылку на разбор можно передать.
 * Удаление доступно только с верным токеном владельца (FR-037).
 */

import { StreamList } from "../components/StreamList.tsx";
import { DocumentView } from "../components/DocumentView.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
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

  return (
    <div className="space-y-4">
      {canManage ? (
        <StreamList
          onOpen={(id) => navigate(knowledgeDocumentPath(id))}
          onDelete={async (id) => {
            const response = await fetch(`/api/streams/${encodeURIComponent(id)}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${adminToken}` },
            });
            if (!response.ok) {
              const data = (await response.json().catch(() => ({}))) as { error?: { message: string } };
              throw new Error(data.error?.message ?? `Удаление не прошло (код ${response.status}).`);
            }
            onChanged();
          }}
          refreshToken={refreshToken}
        />
      ) : (
        <>
          <Alert>
            <AlertTitle className="flex items-center gap-2">
              Только чтение
              <Badge variant="secondary">без токена</Badge>
            </AlertTitle>
            <AlertDescription>
              Список и документы открыты всем. Чтобы удалять записи, укажите токен владельца в
              разделе «Управление».
            </AlertDescription>
          </Alert>
          <StreamList
            onOpen={(id) => navigate(knowledgeDocumentPath(id))}
            refreshToken={refreshToken}
          />
        </>
      )}
    </div>
  );
}
