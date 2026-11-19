/**
 * Раздел MCP: как подключить базу знаний к ИИ-ассистенту (FR-032) и что он
 * получает, кроме инструментов.
 */

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { McpSetup } from "../components/McpSetup.tsx";
import { Link } from "../lib/router.tsx";
import type { ChannelSummary } from "../lib/registry.ts";

interface McpPageProps {
  /** Запись канала: из неё берётся текст ресурса. */
  channel: ChannelSummary | undefined;
  /** Канал прочитан — неважно, есть он или нет. */
  loaded: boolean;
  /** Ошибка чтения канала; при ней пустое состояние не показывается. */
  error: string | undefined;
}

const TOOLS: ReadonlyArray<{ name: string; text: string }> = [
  {
    name: "search_knowledge",
    text: "Поиск по смыслу: вопрос словами, в ответ — разделы эфиров с датой, категорией и ссылкой на момент записи.",
  },
  {
    name: "list_streams",
    text: "Список разобранных трансляций за период.",
  },
  {
    name: "knowledge_stats",
    text: "Границы базы: сколько разобрано и за какой срок.",
  },
];

export function McpPage({ channel, loaded, error }: McpPageProps): React.JSX.Element {
  const agentInfo = channel?.agentStreamerInfo?.trim() ?? "";

  return (
    <div className="space-y-8">
      <p className="text-base leading-relaxed">
        Подключив эту базу как MCP-сервер, ассистент получает доступ к знаниям о трансляциях:
        он сам решает, когда искать, и отвечает со ссылками на конкретные моменты эфира.
      </p>

      <McpSetup />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Что умеет сервер</h2>
        <ul className="space-y-3">
          {TOOLS.map((tool) => (
            <li key={tool.name} className="space-y-1">
              <p className="font-mono text-sm">{tool.name}</p>
              <p className="text-sm text-muted-foreground">{tool.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3 border-t pt-6">
        <h2 className="text-lg font-semibold">Общая информация о стримере</h2>
        <p className="text-sm text-muted-foreground">
          Ассистент получает её как ресурс MCP: он видит её в перечне и может прочитать, не вызывая инструменты.
        </p>

        {error !== undefined && (
          <Alert variant="destructive">
            <AlertTitle>Не удалось получить сведения</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {error === undefined && !loaded && (
          <div className="space-y-3" aria-busy="true" aria-label="Загрузка сведений о стримере">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        )}

        {error === undefined && loaded && agentInfo !== "" && (
          <div className="space-y-2">
            <div className="whitespace-pre-wrap text-sm">{agentInfo}</div>
            <p className="text-sm text-muted-foreground">
              Правится{" "}
              <Link to="/manage" className="underline underline-offset-4">
                в разделе управления
              </Link>
              .
            </p>
          </div>
        )}

        {error === undefined && loaded && channel === undefined && (
          <p className="text-sm text-muted-foreground">
            Ресурса нет: канал ещё не подключён. Подключите его{" "}
            <Link to="/manage" className="underline underline-offset-4">
              в разделе управления
            </Link>
            .
          </p>
        )}

        {error === undefined && loaded && channel !== undefined && agentInfo === "" && (
          <p className="text-sm text-muted-foreground">
            Пока поле пустое, ресурса нет: заполните «Общую информацию о стримере для ассистента»{" "}
            <Link to="/manage" className="underline underline-offset-4">
              в разделе управления
            </Link>
            .
          </p>
        )}
      </section>
    </div>
  );
}
