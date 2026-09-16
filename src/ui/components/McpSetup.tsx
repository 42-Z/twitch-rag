/**
 * Инструкция подключения ассистента (FR-032): готовый JSON с фактическим
 * адресом сервиса, авторизация не нужна (FR-027).
 */

import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";

export function McpSetup(): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const mcpUrl = `${window.location.origin}/mcp`;
  const config = JSON.stringify(
    { mcpServers: { "twitch-knowledge": { type: "http", url: mcpUrl } } },
    null,
    2,
  );

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Подключить ассистента</h2>
      <p className="text-sm text-muted-foreground">
        Добавьте сервер в настройки MCP своего ИИ-ассистента.
      </p>
      <pre className="overflow-x-auto rounded-md bg-muted/50 p-3 text-xs">
        <code>{config}</code>
      </pre>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          void navigator.clipboard.writeText(config).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? "Скопировано" : "Скопировать"}
      </Button>
    </section>
  );
}
