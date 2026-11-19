# Исследование: общая информация о стримере как ресурс MCP

**Дата**: 2026-11-19

**Спецификация**: [spec.md](./spec.md)

Все утверждения ниже опираются на установленный пакет, официальную спецификацию MCP или исходники проекта; ссылка стоит рядом. Где опоры нет — это сказано прямо.

## 1. Что есть сейчас

- MCP-сервер (`src/worker/mcp.ts:32-157`) отдаёт три инструмента: `search_knowledge`, `knowledge_stats`, `list_streams`. Ресурсов нет: создаётся `McpServer` и регистрируются только инструменты.
- Сведения о стримере — одно поле `streamerInfo` в хеше `channel` (`src/shared/registry.ts:19-34`, `:138-155`, `:177-179`). Оно уходит в системную инструкцию разбора (`src/worker/workflow.ts:227-230`, `src/shared/prompt.ts:405-431`); ассистенту не отдаётся.
- Страница читает тот же хеш публичным токеном только на чтение (`src/ui/lib/registry.ts:192-207`), поэтому поле `streamerInfo` уже попадает в браузер вместе с записью канала.
- MCP-сервер публичный, без авторизации — так задумано в 001 (FR-027; `specs/001-stream-archive-rag/contracts/mcp-server.md`).

## 2. Решение: отдельное поле и ресурс

**Что выбрано.** Для ассистента заводится отдельное поле `agentStreamerInfo` в том же хеше `channel`. Оно не участвует в разборе: `buildDocumentSystemPrompt` читает только `streamerInfo`, и это остаётся без изменений. Из нового поля собирается один ресурс MCP.

**Почему не из прежнего поля.** Прежнее поле — рабочая часть инструкции разбора: имена, собеседники, словечки, исправления распознавания. Правка для ассистента меняла бы разбор, и наоборот. Разделение полей — требование владельца (уточнение 2026-11-19); оно же снимает конфликт назначений.

**Почему ресурс, а не инструмент.** Ресурс в MCP — данные, которые клиент получает как контекст по своему усмотрению, не дожидаясь, пока модель решит вызвать инструмент (https://modelcontextprotocol.io/specification/2026-07-28/server/resources, «User Interaction Model»). Общая информация о стримере не является ответом на вопрос; инструмент заставил бы модель решать, когда её запросить.

## 3. Как MCP отдаёт ресурсы

- Спецификация: ресурс адресуется URI; сервер объявляет возможность `resources`; клиент получает перечень `resources/list` и читает `resources/read`; отсутствующий ресурс — ошибка `-32602` (Invalid Params), а не пустой ответ (https://modelcontextprotocol.io/specification/2026-07-28/server/resources, разделы «Capabilities», «Reading Resources», «Error Handling»).
- Установленный `@modelcontextprotocol/server@2.0.0`: `McpServer.registerResource(name, uri, config, readCallback)` (`node_modules/@modelcontextprotocol/server/dist/mcp-DXXb3Vv3.mjs:1569-1593`); `resources/read` ищет ресурс по URI и бросает `ResourceNotFoundError`, если его нет (`:1522-1542`; тип — `dist/createMcpHandler-CLhGwQTn.d.mts:1588`).
- `resources/list` собирается из зарегистрированных ресурсов и ресурсов шаблонов (`:1498-1514`).
- Возможность `listChanged` по умолчанию объявляется как `true` (`:1497`). Сервер без состояния уведомлений не шлёт, поэтому явно передаём `capabilities: { resources: { listChanged: false } }` в конструктор `McpServer` (`:1347-1352`; тип `ServerOptions` — `dist/createMcpHandler-CLhGwQTn.d.mts:2762-2773`).
- Клиент в проверках умеет `listResources()` и `readResource()` (`node_modules/@modelcontextprotocol/client/dist/index.d.mts:2195`, `:2307`).

## 4. Условный перечень: почему низкоуровневый обработчик

**Что выбрано.** Ресурс регистрируется всегда — чтобы существовал обработчик чтения и объявлялась возможность `resources`. Перечень ресурсов заменяется на низкоуровневом сервере: он читает запись канала и отдаёт либо один ресурс, либо пустой список. Чтение ресурса тоже читает запись и при пустом поле бросает `ResourceNotFoundError`.

**Опора.** `McpServer.server` — низкоуровневый `Server`; документация прямо называет его местом для «custom request handlers» (`dist/createMcpHandler-CLhGwQTn.d.mts:3160-3177`). `setRequestHandler` заменяет обработчик (`dist/src-CX2iR2pK.mjs:6753-6775`); `assertCanSetRequestHandler` вызывается только до установки обработчиков `McpServer` (`:6806-6808`), поэтому замена после `registerResource` проходит.

**Альтернативы.**

- *Асинхронная фабрика на каждый запрос.* `McpServerFactory` допускает `Promise` (`dist/createMcpHandler-CLhGwQTn.d.mts:3808`; `agents/dist/handler-stateless-DxYpJ_XF.d.ts:87-91`), но фабрика не знает метода запроса: контекст содержит только эру, `authInfo` и исходный запрос (`dist/createMcpHandler-CLhGwQTn.d.mts:3781-3799`). Чтение канала пришлось бы делать на каждый вызов MCP, включая `search_knowledge`. Поиск реестр не читает (`src/worker/routes/knowledge.ts:88-118`), и отказ реестра начал бы валить поиск — регрессия против FR-006/FR-009 спецификации.
- *Шаблон ресурса с `list`-обработчиком.* `resources/list` добавляет ресурсы шаблонов (`mcp-DXXb3Vv3.mjs:1504-1513`), но шаблон попал бы и в `resources/templates/list`, хотя переменных у него нет. Нужен один адрес, а не шаблон.
- *Ресурс без условного перечня.* Список всегда содержал бы ресурс; пустое поле давало бы ресурс с пустым или подставным текстом — прямо запрещено FR-005/FR-007.

## 5. Метаданные ресурса

| Поле | Значение | Опора |
|---|---|---|
| Адрес | `streamer://info` | Спецификация допускает свои схемы URI по RFC 3986 (раздел «Common URI Schemes») |
| Имя | `streamer_info` | `Resource.name` обязателен (раздел «Data Types») |
| Название | «Общая информация о стримере» | `title` — человекочитаемое имя (раздел «Data Types») |
| Описание | «Кто такой стример и о чём канал: общие сведения для ассистента» | `description` — необязательное пояснение (раздел «Data Types») |
| Тип | `text/plain` | Ресурс текстовый (раздел «Text Content») |

Адрес постоянный: правка текста его не меняет. Содержимое — текст поля без ведущих и замыкающих пробелов, без обёртки инструкции, целиком в пределах 20 000 знаков.

## 6. Поле и API

**Хранение.** Новое поле `agentStreamerInfo` — в том же хеше `channel`, рядом с `streamerInfo`. `setChannel` перечисляет поля поимённо (`src/shared/registry.ts:161-171`), поэтому подключение канала новое поле не затирает — так же, как не затирает прежнее. Новый метод `setAgentStreamerInfo` пишет только его.

**Запись.** Новый владельческий путь `PUT /api/agent-streamer` с телом `{ info }`, тем же пределом 20 000 знаков (`MAX_STREAMER_INFO_CHARS`, `src/worker/routes/channel.ts:47`) и той же защитой токеном. Отдельный путь, а не расширение `/api/streamer`: у поля другой получатель, и расширение сделало бы один запрос носителем двух независимых текстов, а также изменило бы прежний контракт.

**Проверки.** Контракт нового пути повторяет `tests/contract/streamer.test.ts`: сохранение дословно, пустая строка — осознанное «не задано», предел длины, отказ без токена, отказ на чужое поле.

## 7. Страница

- **Управление.** Второе поле в `ManagePage` с собственным названием и пояснением. Существующая механика `submit`/`busy`/`message` (`src/ui/pages/ManagePage.tsx:43-95`) расширяется ещё одним действием. Поле показывает сохранённое значение из записи канала (`ChannelSummary`), а не из памяти формы.
- **MCP.** `McpPage` получает запись канала из `App` (`src/ui/App.tsx:84-88`, `:97-119`) и показывает текущий текст ресурса. Состояния — как на главной (`src/ui/pages/HomePage.tsx:101-114`): ожидание — `Skeleton`, отказ чтения — `Alert`, пустое поле — текст «ресурса нет» и куда его заполнить. `App` сейчас глотает ошибку чтения канала и отдаёт `undefined`; для честного пустого состояния добавляется различение «не прочитано» и «не задано».
- **Данные страницы.** Новое поле попадает в `ChannelSummary` и читается тем же публичным токеном (`src/ui/lib/registry.ts:50-57`, `:192-207`); отдельных запросов не нужно.

## 8. Проверки

- Worker: MCP-клиент через `InMemoryTransport` — тот же приём, что в `tests/worker/worker.test.ts:215-243`. Проверяются: перечень с заполненным полем, чтение, пустое поле (перечня нет, чтение — отказ), отсутствие подстановки из `streamerInfo`, смена текста между чтениями. Подставной реестр уже отвечает на `HGETALL` (`tests/worker/network.ts:66-89`).
- Логика: поле реестра, новый путь, разметка страниц. `tests/unit/manage-page.test.tsx` и `tests/unit/pages-render.test.tsx` дополняются; для MCP-раздела добавляется проверка содержимого.
- Разбор документов: `tests/unit/prompt.test.ts` сверяет хеш инструкции; новых полей в инструкции быть не должно.
- Типы и сборка: `npm run typecheck`, `npm run build`.
- Документация: Vitest 4 (https://v4.vitest.dev/llms.txt).

## 9. Источники

- MCP, ресурсы: https://modelcontextprotocol.io/specification/2026-07-28/server/resources
- Установленный пакет: `@modelcontextprotocol/server@2.0.0` — `dist/mcp-DXXb3Vv3.mjs`, `dist/src-CX2iR2pK.mjs`, `dist/createMcpHandler-CLhGwQTn.d.mts`
- Обработчик без состояния: `agents@0.23.0` — `dist/handler-stateless-DxYpJ_XF.d.ts`
- Клиент проверок: `@modelcontextprotocol/client@2.0.0` — `dist/index.d.mts`
- Предел внешних обращений Cloudflare: https://developers.cloudflare.com/workers/platform/limits/#subrequests
- Upstash Redis: `@upstash/redis@1.38.4`, команды `HGETALL`/`HSET` — `https://upstash.com/docs/redis/features/restapi`
- Vitest: https://v4.vitest.dev/llms.txt
- Скиллы: `cloudflare:build-mcp` (вызван), `workers-best-practices`, `upstash:upstash-redis-js`
