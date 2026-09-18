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
import { documentName } from "@/shared/document-name.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { StreamActions } from "./StreamActions.tsx";
import { formatDate, recordLabel } from "../lib/format.ts";
import { listStreams, type StreamSummary } from "../lib/registry.ts";

interface StreamListProps {
  onOpen: (vodId: string) => void;
  onDelete?: (vodId: string) => Promise<void>;
  onReparse?: (vodId: string) => Promise<void>;
  /** Растёт при внешнем изменении реестра (после добавления/удаления) — заставляет перечитать список. */
  refreshToken?: number;
}

export function StreamList({ onOpen, onDelete, onReparse, refreshToken }: StreamListProps): React.JSX.Element {
  const [streams, setStreams] = useState<StreamSummary[] | undefined>(undefined);
  /** Сбой загрузки списка: показывать нечего, поэтому им и ограничивается весь экран. */
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  /**
   * Сбой действия. Держится отдельно от сбоя загрузки: действие относится к
   * одной записи, и убирать из-за него весь список нельзя — владелец терял бы
   * его целиком из-за отказа, скажем, повторного разбора, который идёт прямо
   * сейчас и отвергнут по правилу FR-030.
   */
  const [rowError, setRowError] = useState<{ vodId: string; text: string } | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setLoadError(undefined);
    listStreams()
      .then((result) => {
        if (!cancelled) setStreams(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  if (loadError !== undefined) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Реестр недоступен</AlertTitle>
        <AlertDescription>{loadError}</AlertDescription>
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

  function failed(vodId: string): React.JSX.Element | null {
    if (rowError === undefined || rowError.vodId !== vodId) return null;
    return <p className="text-sm text-destructive">{rowError.text}</p>;
  }

  function actions(stream: StreamSummary): React.JSX.Element {
    return (
      <StreamActions
        stream={stream}
        onOpen={onOpen}
        {...(onReparse === undefined ? {} : { onReparse })}
        {...(onDelete === undefined ? {} : { onDelete })}
        onFailed={(vodId, text) => setRowError({ vodId, text })}
        onDone={(vodId, outcome) => {
          setRowError(undefined);
          setStreams((current) =>
            current === undefined
              ? current
              : outcome === "deleted"
                ? current.filter((item) => item.vodId !== vodId)
                : // Разбор принят: запись уходит в «В обработке» до следующего
                  // перечитывания списка.
                  current.map((item) =>
                    item.vodId === vodId ? { ...item, status: "processing" as const } : item,
                  ),
          );
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">
          Разобрано ({ready.length})
        </h3>
        <ul className="divide-y">
          {/* Заголовок с площадки в показе не участвует: документ
              представляется именем, выработанным по содержанию эфира
              (FR-025, FR-027). У записи, разобранной до появления имён, имени
              ещё нет — она и подписана «без названия» до тех пор, пока имя не
              выработается; рядом стоит дата, и запись остаётся различимой. */}
          {ready.map((stream) => (
            <li key={stream.vodId} className="space-y-2 py-4 first:pt-0">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium">{documentName(stream) || "Без названия"}</p>
                  <p className="text-sm text-muted-foreground">
                    {formatDate(stream.publishedAt)} · {formatDuration(stream.durationSeconds)} · разделов:{" "}
                    {stream.sectionCount}
                  </p>
                </div>
                {actions(stream)}
              </div>
              {/* У разобранной записи причина — не отказ, а изъян разбора:
                  столько-то эфира не попало ни в один раздел. Показать её
                  больше негде, и без этой строки владелец читал бы документ
                  как полный, не зная, что часть эфира в базе отсутствует. */}
              {stream.reason !== undefined && stream.reason !== "" && (
                <p className="text-sm text-amber-600">{stream.reason}</p>
              )}
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
              {failed(stream.vodId)}
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
              <li key={stream.vodId} className="space-y-2 py-4 first:pt-0">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    {/* Имени у такой записи может не быть вовсе: документ ещё
                        не составлен. Тогда запись опознаётся по дате эфира —
                        заголовок с площадки не показывается и здесь. */}
                    <p className="font-medium">{recordLabel(stream)}</p>
                    <p className="text-sm text-muted-foreground">
                      {stream.status === "processing"
                        ? "разбирается…"
                        : `не удалось разобрать: ${stream.reason ?? ""}`}
                    </p>
                  </div>
                  {actions(stream)}
                </div>
                {failed(stream.vodId)}
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
              <li key={stream.vodId} className="space-y-2 py-4 first:pt-0">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-medium text-muted-foreground">{recordLabel(stream)}</p>
                    <p className="text-sm text-muted-foreground">{stream.reason ?? "причина не указана"}</p>
                  </div>
                  {actions(stream)}
                </div>
                {failed(stream.vodId)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
