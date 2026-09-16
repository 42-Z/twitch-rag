/**
 * Раздел API: как обращаться к базе знаний из своего кода (FR-036).
 *
 * Адреса приведены от текущего происхождения: страница может открываться и
 * на рабочем адресе, и на локальном, а примеры должны работать у обоих.
 */

import { useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Separator } from "@/components/ui/separator.tsx";

interface Endpoint {
  method: "GET" | "POST";
  path: string;
  text: string;
  request?: string;
  response?: string;
}

const ERROR_CODES: ReadonlyArray<{ code: string; status: string; text: string }> = [
  { code: "invalid_input", status: "400", text: "Запрос заполнен неверно: пустой вопрос, слишком длинный текст, неверная дата." },
  { code: "not_found", status: "404", text: "Документа по этой записи нет." },
  { code: "vod_unavailable", status: "404", text: "Запись удалена или открыта только подписчикам." },
  { code: "unauthorized", status: "401", text: "Неверный токен владельца." },
  { code: "channel_not_set", status: "409", text: "Канал ещё не указан — сервису нечего отслеживать." },
  { code: "already_processed", status: "409", text: "Эта запись уже разобрана." },
  { code: "busy", status: "409", text: "Запись сейчас разбирается — удалить её нельзя." },
  { code: "rate_limited", status: "429", text: "Слишком много запросов с одного адреса." },
  { code: "upstream_unavailable", status: "503", text: "Внешний сервис недоступен, попробуйте позже." },
  { code: "internal", status: "500", text: "Внутренняя ошибка сервиса." },
];

function CodeBlock({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed">
        <code>{text}</code>
      </pre>
      <Button
        size="sm"
        variant="ghost"
        className="absolute right-1 top-1 h-7"
        onClick={() => {
          navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? "Скопировано" : "Скопировать"}
      </Button>
    </div>
  );
}

function EndpointSection({ endpoint }: { endpoint: Endpoint }): React.JSX.Element {
  return (
    <section className="space-y-3 border-t pt-6">
      <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold">
        <Badge variant="secondary" className="font-mono">
          {endpoint.method}
        </Badge>
        <span className="font-mono text-sm font-normal">{endpoint.path}</span>
      </h2>
      <p className="text-sm text-muted-foreground">{endpoint.text}</p>

      {endpoint.request !== undefined && (
        <div className="space-y-1">
          <p className="text-sm font-medium">Запрос</p>
          <CodeBlock text={endpoint.request} />
        </div>
      )}
      {endpoint.response !== undefined && (
        <div className="space-y-1">
          <p className="text-sm font-medium">Ответ</p>
          <CodeBlock text={endpoint.response} />
        </div>
      )}
    </section>
  );
}

export function ApiPage(): React.JSX.Element {
  const origin = window.location.origin;

  const endpoints: readonly Endpoint[] = [
    {
      method: "POST",
      path: "/api/knowledge/search",
      text: "Главный запрос: вопрос словами, в ответ — разделы эфиров. Публичный, авторизация не нужна.",
      request: `curl -X POST ${origin}/api/knowledge/search \\
  -H 'content-type: application/json' \\
  -d '{"query":"что говорили про Minecraft","topK":5}'`,
      response: `{
  "found": true,
  "documents": [
    {
      "id": "2873255697:13",
      "topic": "Обсуждение сервера и подходов к разработке",
      "text": "Участники обсуждают платформу SP и подходы к её разработке. Идёт спор о вайпкодинге…",
      "score": 0.73570734,
      "category": "Minecraft",
      "stream": {
        "vodId": "2873255697",
        "title": "РАССКАЗЫВАЮ ИСТОРИИ И ЧЁ-ТА ДЕЛАЮ // !донат !приватка !правила !funpay !tornado !тг",
        "publishedAt": "2026-09-13T16:32:54.000Z",
        "url": "https://www.twitch.tv/videos/2873255697?t=2h41m40s"
      },
      "startSeconds": 9700,
      "endSeconds": 11000
    },
    … ещё четыре раздела …
  ],
  "stats": { "returned": 5, "latencyMs": 737 }
}`,
    },
    {
      method: "GET",
      path: "/api/knowledge/stats",
      text: "За какой срок есть сведения, сколько разобрано и сколько разделов. По этому ассистент честно говорит о пределах своих знаний.",
      response: `{
  "channel": "5opka",
  "streams": { "ready": 1, "skipped": 0 },
  "sections": 22,
  "coverage": { "from": "2026-09-13T16:32:54.000Z", "to": "2026-09-13T16:32:54.000Z" },
  "categories": ["Just Chatting", "Minecraft"],
  "lastIndexedAt": "2026-09-15T22:19:49.000Z"
}`,
    },
    {
      method: "GET",
      path: "/api/streams/{vodId}/document",
      text: "Документ целиком в разметке Markdown: заголовки разделов со временем и категорией.",
      request: `curl ${origin}/api/streams/2873255697/document`,
      response: `# РАССКАЗЫВАЮ ИСТОРИИ И ЧЁ-ТА ДЕЛАЮ // !донат !приватка !правила !funpay !tornado !тг

**Эфир**: 2026-09-13 · **Длительность**: 5 ч 17 мин

**Категории**: Just Chatting, Minecraft

## Настройка стрима и технические проблемы [0:00:00 — 0:08:20 · Just Chatting]

Стрим начался с музыкальной заставки и серии благодарностей зрителей за донаты…`,
    },
  ];

  return (
    <div className="space-y-8">
      <section className="space-y-3 text-sm leading-relaxed">
        <p>
          Тела запросов и ответов — JSON в UTF-8, время — ISO 8601. Авторизация нужна только
          для управления содержимым базы; поиск и чтение документов открыты всем.
        </p>
        <p className="text-muted-foreground">
          Ограничение частоты — 30 запросов в минуту с одного адреса; при превышении приходит
          ответ <span className="font-mono">429</span> с заголовком{" "}
          <span className="font-mono">Retry-After</span>.
        </p>
      </section>

      {endpoints.map((endpoint) => (
        <EndpointSection key={endpoint.path} endpoint={endpoint} />
      ))}

      <section className="space-y-3 border-t pt-6">
        <h2 className="text-lg font-semibold">Ошибки</h2>
        <p className="text-sm text-muted-foreground">
          Любая ошибка приходит в одном виде — с кодом, текстом для человека и подсказкой:
        </p>
        <CodeBlock
          text={`{
  "error": {
    "code": "vod_unavailable",
    "message": "Запись недоступна: она удалена или открыта только подписчикам.",
    "hint": "Проверьте ссылку или добавьте другую запись."
  }
}`}
        />
        <Separator />
        <ul className="space-y-2 text-sm">
          {ERROR_CODES.map((item) => (
            <li key={item.code} className="flex flex-wrap items-baseline gap-2">
              <code className="font-mono text-xs">{item.code}</code>
              <Badge variant="outline" className="font-mono text-xs">
                {item.status}
              </Badge>
              <span className="text-muted-foreground">{item.text}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
