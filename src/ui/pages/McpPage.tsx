/**
 * Раздел MCP: как подключить базу знаний к ИИ-ассистенту (FR-032).
 */

import { McpSetup } from "../components/McpSetup.tsx";

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

export function McpPage(): React.JSX.Element {
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
    </div>
  );
}
