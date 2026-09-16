/**
 * Список того, что знает база: разобранные трансляции и отдельно —
 * пропущенные с причиной (FR-029, FR-030).
 *
 * Данные приходят напрямую из реестра, минуя Worker (`lib/registry.ts`).
 * Загрузка, пустота и ошибка показаны явно — молчание здесь запрещено
 * принципом III.
 */

import { useEffect, useState } from "react";
import { formatDuration } from "@/shared/time.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { listStreams, type StreamSummary } from "../lib/registry.ts";

function formatDate(iso: string): string {
  if (iso === "") return "дата неизвестна";
  return new Date(iso).toLocaleDateString("ru-RU", { year: "numeric", month: "long", day: "numeric" });
}

interface StreamListProps {
  onOpen: (vodId: string) => void;
  onDelete?: (vodId: string) => Promise<void>;
  /** Растёт при внешнем изменении реестра (после добавления/удаления) — заставляет перечитать список. */
  refreshToken?: number;
}

export function StreamList({ onOpen, onDelete, refreshToken }: StreamListProps): React.JSX.Element {
  const [streams, setStreams] = useState<StreamSummary[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [deletingId, setDeletingId] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    listStreams()
      .then((result) => {
        if (!cancelled) setStreams(result);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  if (error !== undefined) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Реестр недоступен</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (streams === undefined) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Загрузка списка трансляций">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  const ready = streams.filter((stream) => stream.status === "ready");
  const skipped = streams.filter((stream) => stream.status === "skipped");
  const inProgress = streams.filter((stream) => stream.status === "processing" || stream.status === "failed");

  if (streams.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Трансляций пока нет.</p>
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">
          Разобрано ({ready.length})
        </h3>
        <ul className="divide-y">
          {ready.map((stream) => (
            <li key={stream.vodId} className="space-y-2 py-4 first:pt-0">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium">{stream.title || "Без названия"}</p>
                  <p className="text-sm text-muted-foreground">
                    {formatDate(stream.publishedAt)} · {formatDuration(stream.durationSeconds)} · разделов:{" "}
                    {stream.sectionCount}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="secondary" onClick={() => onOpen(stream.vodId)}>
                    Открыть документ
                  </Button>
                  {onDelete !== undefined && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={deletingId === stream.vodId}
                      onClick={() => {
                        if (!window.confirm(`Удалить «${stream.title}» из базы знаний?`)) return;
                        setDeletingId(stream.vodId);
                        onDelete(stream.vodId)
                          .then(() => setStreams((current) => current?.filter((item) => item.vodId !== stream.vodId)))
                          .catch((deleteError: unknown) =>
                            setError(deleteError instanceof Error ? deleteError.message : String(deleteError)),
                          )
                          .finally(() => setDeletingId(undefined));
                      }}
                    >
                      {deletingId === stream.vodId ? "Удаление…" : "Удалить"}
                    </Button>
                  )}
                </div>
              </div>
              {stream.categories.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {[...new Set(stream.categories.map((chapter) => chapter.title))]
                    .filter((title) => title !== "")
                    .map((title) => (
                      <Badge key={title} variant="secondary">
                        {title}
                      </Badge>
                    ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {inProgress.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">
            В обработке ({inProgress.length})
          </h3>
          <ul className="divide-y">
            {inProgress.map((stream) => (
              <li key={stream.vodId} className="space-y-0.5 py-4 first:pt-0">
                <p className="font-medium">{stream.title || stream.vodId}</p>
                <p className="text-sm text-muted-foreground">
                  {stream.status === "processing" ? "разбирается…" : `не удалось разобрать: ${stream.reason ?? ""}`}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {skipped.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">
            Пропущено ({skipped.length})
          </h3>
          <ul className="divide-y">
            {skipped.map((stream) => (
              <li key={stream.vodId} className="space-y-0.5 py-4 first:pt-0">
                <p className="font-medium text-muted-foreground">{stream.title || stream.vodId}</p>
                <p className="text-sm text-muted-foreground">{stream.reason ?? "причина не указана"}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
