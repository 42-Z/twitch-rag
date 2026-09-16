/**
 * Инструкция подключения ассистента (FR-032): готовый JSON с фактическим
 * адресом сервиса, авторизация не нужна (FR-027).
 */

import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";

export function McpSetup(): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const mcpUrl = `${window.location.origin}/mcp`;
  const config = JSON.stringify(
    { mcpServers: { "twitch-knowledge": { type: "http", url: mcpUrl } } },
    null,
    2,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Подключить ассистента</CardTitle>
        <p className="text-sm text-muted-foreground">
          Добавьте сервер в настройки MCP своего ИИ-ассистента. Авторизация не требуется.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
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
      </CardContent>
    </Card>
  );
}
