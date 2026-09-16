/**
 * Главная: что это за база знаний, что она даёт и что в ней сейчас есть.
 */

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Link } from "../lib/router.tsx";

/** Чем база полезна и где это делается. */
const USE_CASES: ReadonlyArray<{ title: string; text: string; to: string; link: string }> = [
  {
    title: "Ответы по эфирам",
    text: "ИИ-ассистент ищет в базе сам и отвечает со ссылками на конкретные минуты трансляций.",
    to: "/assistant",
    link: "Подключить",
  },
  {
    title: "Документ каждой трансляции",
    text: "Разделы по темам, время начала каждого и категория эфира.",
    to: "/knowledge",
    link: "Смотреть документы",
  },
  {
    title: "Запросы из своего кода",
    text: "Поиск и документы доступны обычными HTTP-запросами.",
    to: "/api",
    link: "Справочник запросов",
  },
];

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
    <div className="space-y-8">
      <p className="text-base leading-relaxed">
        База знаний по записям трансляций канала. Каждый эфир разобран в связный документ:
        разделы по темам, время начала каждого, категория. Нужное ищется вопросом своими
        словами — в ответ приходит тот момент эфира, где об этом говорили.
      </p>

      <section className="space-y-4 border-t pt-6">
        <h2 className="text-lg font-semibold">Что это даёт</h2>
        <ul className="space-y-4">
          {USE_CASES.map((item) => (
            <li key={item.to} className="space-y-0.5">
              <p className="font-medium">{item.title}</p>
              <p className="text-sm text-muted-foreground">{item.text}</p>
              <Link to={item.to} className="text-sm underline underline-offset-4">
                {item.link}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-4 border-t pt-6">
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
    </div>
  );
}
