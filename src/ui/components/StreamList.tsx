/**
 * Список того, что знает база: разобранные трансляции и отдельно —
 * пропущенные с причиной (FR-029, FR-030).
 *
 * Данные приходят напрямую из реестра, минуя Worker (`lib/registry.ts`).
 * Загрузка, пустота и ошибка показаны явно — молчание здесь запрещено
 * принципом III.
 */

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { listStreams, type StreamSummary } from "../lib/registry.ts";

function formatDate(iso: string): string {
  if (iso === "") return "дата неизвестна";
  return new Date(iso).toLocaleDateString("ru-RU", { year: "numeric", month: "long", day: "numeric" });
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
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
      <p className="text-sm text-muted-foreground">
        Трансляций пока нет. Добавьте канал и первую запись, чтобы база начала расти.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">
          Разобрано ({ready.length})
        </h3>
        <div className="space-y-2">
          {ready.map((stream) => (
            <Card key={stream.vodId}>
              <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                <div>
                  <CardTitle className="text-base">{stream.title || "Без названия"}</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {formatDate(stream.publishedAt)} · {formatDuration(stream.durationSeconds)} · разделов:{" "}
                    {stream.sectionCount}
                  </p>
                </div>
                <div className="flex gap-2">
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
              </CardHeader>
              {stream.categories.length > 0 && (
                <CardContent className="flex flex-wrap gap-1 pt-0">
                  {[...new Set(stream.categories.map((chapter) => chapter.title))]
                    .filter((title) => title !== "")
                    .map((title) => (
                      <Badge key={title} variant="secondary">
                        {title}
                      </Badge>
                    ))}
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      </section>

      {inProgress.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">
            В обработке ({inProgress.length})
          </h3>
          <div className="space-y-2">
            {inProgress.map((stream) => (
              <Card key={stream.vodId}>
                <CardHeader className="space-y-0">
                  <CardTitle className="text-base">{stream.title || stream.vodId}</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {stream.status === "processing" ? "разбирается…" : `не удалось разобрать: ${stream.reason ?? ""}`}
                  </p>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>
      )}

      {skipped.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">
            Пропущено ({skipped.length})
          </h3>
          <div className="space-y-2">
            {skipped.map((stream) => (
              <Card key={stream.vodId} className="border-dashed">
                <CardHeader className="space-y-0">
                  <CardTitle className="text-base text-muted-foreground">
                    {stream.title || stream.vodId}
                  </CardTitle>
                  <p className="text-sm text-muted-foreground">{stream.reason ?? "причина не указана"}</p>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
