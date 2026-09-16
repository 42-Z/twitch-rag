/**
 * Раздел MCP: как подключить базу знаний к ИИ-ассистенту (FR-032).
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { McpSetup } from "../components/McpSetup.tsx";

const TOOLS: ReadonlyArray<{ name: string; text: string }> = [
  {
    name: "search_knowledge",
    text: "Поиск по смыслу: вопрос словами, в ответ — разделы эфиров с датой, категорией и ссылкой на момент записи.",
  },
  {
    name: "list_streams",
    text: "Список разобранных трансляций за период — чтобы понять, о каких эфирах вообще есть сведения.",
  },
  {
    name: "knowledge_stats",
    text: "Границы базы: сколько разобрано и за какой срок. По ним ассистент честно скажет, чего он не знает.",
  },
];

export function McpPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Что это даёт</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed">
          <p>
            Подключив эту базу как MCP-сервер, ассистент получает доступ к знаниям о
            трансляциях: он сам решает, когда искать, и отвечает со ссылками на конкретные
            моменты эфира.
          </p>
          <p className="text-muted-foreground">
            Авторизация не нужна — знания публичны, а обращения ограничены по частоте, чтобы
            чужой интерес не расходовал ресурсы владельца.
          </p>
        </CardContent>
      </Card>

      <McpSetup />

      <Card>
        <CardHeader>
          <CardTitle>Что умеет сервер</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {TOOLS.map((tool) => (
              <li key={tool.name} className="space-y-1">
                <p className="font-mono text-sm">{tool.name}</p>
                <p className="text-sm text-muted-foreground">{tool.text}</p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
