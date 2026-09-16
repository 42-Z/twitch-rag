/**
 * Главная: что это за сервис, как он устроен и что сейчас лежит в базе.
 */

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Link } from "../lib/router.tsx";

interface Stats {
  channel: string | null;
  streams: { ready: number; skipped: number };
  sections: number;
  coverage: { from: string | null; to: string | null };
  categories: string[];
  lastIndexedAt: string | null;
}

const STEPS: ReadonlyArray<{ title: string; text: string }> = [
  {
    title: "Следит за каналом",
    text: "Раз в час сервис смотрит список записей канала и берёт самую раннюю из ещё не разобранных.",
  },
  {
    title: "Расшифровывает эфир",
    text: "Запись скачивается во временный бокс, режется на куски по десять минут и распознаётся. Аудио и расшифровка после этого не хранятся.",
  },
  {
    title: "Составляет документ",
    text: "Модель пересказывает эфир связным текстом и делит его на разделы по темам — с временем начала и категорией трансляции.",
  },
  {
    title: "Отдаёт знания",
    text: "Разделы попадают в векторный поиск, документ целиком — в хранилище. Дальше база отвечает на вопросы ассистентов.",
  },
];

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
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Что это</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed">
          <p>
            База знаний по записям трансляций канала. Сервис сам следит за эфирами, разбирает
            каждый новый и складывает получившееся в поиск по смыслу — чтобы ИИ-ассистент мог
            отвечать на вопросы о том, что обсуждали на стримах.
          </p>
          <p className="text-muted-foreground">
            Записи и расшифровки не хранятся: остаётся только документ о трансляции и разделы
            в поиске. Подключить ассистента — в разделе{" "}
            <Link to="/assistant" className="underline underline-offset-4">
              MCP
            </Link>
            , посмотреть разобранное — в разделе{" "}
            <Link to="/knowledge" className="underline underline-offset-4">
              Знания
            </Link>
            .
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Как это устроено</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-4">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex gap-3">
                <Badge variant="secondary" className="mt-0.5 h-6 w-6 shrink-0 justify-center rounded-full p-0">
                  {index + 1}
                </Badge>
                <div className="space-y-1">
                  <p className="text-sm font-medium">{step.title}</p>
                  <p className="text-sm text-muted-foreground">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Сейчас в базе</CardTitle>
        </CardHeader>
        <CardContent>
          {error !== undefined && (
            <Alert variant="destructive">
              <AlertTitle>Не удалось получить сводку</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {error === undefined && stats === undefined && (
            <div className="space-y-2" aria-busy="true" aria-label="Загрузка сводки">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-1/3" />
            </div>
          )}

          {stats !== undefined && (
            <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
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
        </CardContent>
      </Card>
    </div>
  );
}
