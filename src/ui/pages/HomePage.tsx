/**
 * Главная: что сейчас лежит в базе.
 *
 * Рассказа о том, как сервис устроен внутри, здесь нет намеренно: человеку
 * нужны границы знаний — за какой срок, сколько разобрано, по каким темам.
 */

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";

interface Stats {
  channel: string | null;
  streams: { ready: number; skipped: number };
  sections: number;
  coverage: { from: string | null; to: string | null };
  categories: string[];
  lastIndexedAt: string | null;
}

function useStats(): { stats: Stats | undefined; error: string | undefined } {
  const [stats, setStats] = useState<Stats | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/knowledge/stats")
      .then(async (response) => {
        if (!response.ok) throw new Error(`Сводка недоступна (код ${response.status}).`);
        return (await response.json()) as Stats;
      })
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { stats, error };
}

/** Дата словами: в сводке приходят машинные отметки времени. */
function formatDate(iso: string | null): string {
  if (iso === null || iso === "") return "—";
  return new Date(iso).toLocaleDateString("ru-RU", { year: "numeric", month: "long", day: "numeric" });
}

export function HomePage(): React.JSX.Element {
  const { stats, error } = useStats();

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Сейчас в базе</h2>

      {error !== undefined && (
        <Alert variant="destructive">
          <AlertTitle>Не удалось получить сводку</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {error === undefined && stats === undefined && (
        <div className="space-y-3" aria-busy="true" aria-label="Загрузка сводки">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/3" />
        </div>
      )}

      {stats !== undefined && (
        <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
          <div className="space-y-0.5">
            <dt className="text-muted-foreground">Канал</dt>
            <dd>{stats.channel ?? "не указан"}</dd>
          </div>
          <div className="space-y-0.5">
            <dt className="text-muted-foreground">Разобрано трансляций</dt>
            <dd>
              {stats.streams.ready}
              {stats.streams.skipped > 0 && (
                <span className="text-muted-foreground"> · пропущено {stats.streams.skipped}</span>
              )}
            </dd>
          </div>
          <div className="space-y-0.5">
            <dt className="text-muted-foreground">Разделов в поиске</dt>
            <dd>{stats.sections}</dd>
          </div>
          <div className="space-y-0.5">
            <dt className="text-muted-foreground">Последний разбор</dt>
            <dd>{formatDate(stats.lastIndexedAt)}</dd>
          </div>
          <div className="space-y-0.5">
            <dt className="text-muted-foreground">Эфиры</dt>
            <dd>
              {stats.coverage.from === null
                ? "пока пусто"
                : `${formatDate(stats.coverage.from)} — ${formatDate(stats.coverage.to)}`}
            </dd>
          </div>
          <div className="space-y-0.5">
            <dt className="text-muted-foreground">Категории</dt>
            <dd>{stats.categories.length > 0 ? stats.categories.join(", ") : "—"}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
