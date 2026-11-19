# Implementation Plan: Общая информация о стримере для ассистента как ресурс MCP

**Branch**: `010-mcp-streamer-resources` | **Date**: 2026-11-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/010-mcp-streamer-resources/spec.md`

## Summary

Для ассистента, подключённого по MCP, заводится отдельное поле `agentStreamerInfo` в записи канала. Прежнее поле `streamerInfo` остаётся частью инструкции разбора и в ресурс не попадает. Из нового поля собирается один ресурс `streamer://info`: он появляется в `resources/list`, только когда поле непустое; чтение отдаёт сохранённый текст без обёртки и обрезки; при пустом поле ресурса нет и чтение отвечает «не найден». Ресурс публичный, без авторизации; инструменты не меняются.

Перечень ресурсов зависит от данных, поэтому `resources/list` заменяется на низкоуровневом `McpServer.server`; это документированный способ задать свой обработчик. Альтернативы и опоры — в [research.md](./research.md) §4. Новых зависимостей, внешних ресурсов и расходов нет; программа конвейера не меняется.

## Technical Context

**Language/Version**: TypeScript; Worker — Cloudflare Workers; инструмент разработки — Node.js ≥ 24.12; страница — React 19

**Primary Dependencies**: `@modelcontextprotocol/server@2.0.0` (McpServer, ресурсы), `agents@0.23.0` (`createMcpHandler` без состояния), `@upstash/redis@1.38.4` (реестр), `@modelcontextprotocol/client@2.0.0` (проверки). Новых зависимостей нет.

**Storage**: Upstash Redis, хеш `channel`; новое поле `agentStreamerInfo`. Новых хранилищ и схем нет. Прежнее `streamerInfo` не меняется.

**Testing**: Vitest 4; набор логики под Node и набор Worker'а в его среде (`@cloudflare/vitest-plugin`, подмена сети через `@msw/cloudflare`). MCP проверяется клиентом через `InMemoryTransport` (`tests/worker/worker.test.ts:215-243`), страница — `renderToStaticMarkup` (`tests/unit/pages-render.test.tsx`).

**Target Platform**: Cloudflare Workers; предел 50 внешних обращений на вызов (https://developers.cloudflare.com/workers/platform/limits/#subrequests). Перечень и чтение ресурса добавляют по одному чтению записи канала; остальные пути не меняются.

**Project Type**: сервис с тремя средами исполнения; затрагиваются Worker, общий модуль реестра и страница. Программа конвейера и машина Upstash не затрагиваются.

**Performance Goals**: на `resources/list` и `resources/read` — одно чтение записи канала; содержимое — до 20 000 знаков целиком; вызовов моделей нет.

**Constraints**: сервер публичный, без авторизации; без состояния; уведомлений об изменениях нет (`resources.listChanged: false`); перечень и содержимое — на момент запроса; поле для разбора не используется как запасной источник; поле для ассистента не попадает в инструкцию разбора.

**Scale/Scope**: один канал, один ресурс, текст до 20 000 знаков.

## Constitution Check

*GATE: проходит до Phase 0 и повторно после Phase 1.*

| Принцип | Оценка |
|---|---|
| I. Документация прежде действия | Выполнено: вызван скилл `cloudflare:build-mcp`; прочитаны установленный `@modelcontextprotocol/server@2.0.0` (`dist/mcp-DXXb3Vv3.mjs`, `dist/src-CX2iR2pK.mjs`, типы), официальная спецификация MCP 2026-07-28 (ресурсы) и типы клиента. Ссылки — в [research.md](./research.md) §3–5, §9 |
| II. Чистый расширяемый код | Выполнено: новое поле — в существующем `Registry`; новый владельческий путь — в существующем `routes/channel.ts`; ресурс и его перечень — в `mcp.ts`; новых слоёв и зависимостей нет. Перечень ресурсов считается в одном месте |
| III. Пользовательский опыт | Выполнено: два поля с различимыми названиями и пояснениями; раздел MCP показывает текущий текст, ожидание — `Skeleton`, отказ чтения — `Alert`, пустое поле объясняет, где заполнить. Пустое состояние не выдаёт себя за «сведений нет», если запись не прочитана |
| IV. Проект всегда в рабочем состоянии | Выполнено: типы, проверки и сборка — до слияния; мёртвого кода и заглушек нет; отказ хранилища — явная ошибка, а не пустой ответ. Прежние проверки инструментов и инструкции разбора проходят без правок ожиданий |
| V. Простота | Выполнено: одно новое поле вместо структуры; один ресурс вместо шаблонов; низкоуровневый обработчик перечня — один вызов в `mcp.ts`, альтернативы разобраны в [research.md](./research.md) §4. Страница использует существующие компоненты |
| VI. Логика дизайна | Выполнено: у каждого поля пояснение, куда идёт текст; в разделе MCP показывается сам текст, а не рассказ о нём; новых фонов и декоративных контейнеров нет |
| Расходы | Новых расходов нет: чтение записи канала — одно обращение на запрос ресурса, вызовов моделей нет, платный тариф не требуется |

Нарушений нет, раздела «Complexity Tracking» не требуется.

## Project Structure

### Documentation (this feature)

```text
specs/010-mcp-streamer-resources/
├── plan.md              # этот файл
├── research.md          # Phase 0: решение, условный перечень, опоры
├── data-model.md        # Phase 1: поля, ресурс, состояния
├── contracts/
│   ├── mcp-resource.md  # ресурс: метаданные, list/read, ошибки
│   └── agent-streamer-api.md  # PUT /api/agent-streamer
├── quickstart.md        # Phase 1: порядок проверки
├── spec.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/shared/registry.ts        # ChannelRecord.agentStreamerInfo; getChannel; setAgentStreamerInfo
src/worker/routes/channel.ts  # handleSetAgentStreamer; общий предел 20 000
src/worker/index.ts           # маршрут PUT /api/agent-streamer
src/worker/mcp.ts             # ресурс streamer://info; resources.listChanged: false;
                              # перечень на низкоуровневом сервере; чтение с отказом
src/ui/lib/registry.ts        # ChannelSummary.agentStreamerInfo
src/ui/App.tsx                # состояние чтения канала: загружено/ошибка; передача в McpPage
src/ui/pages/ManagePage.tsx   # второе поле для ассистента; прежнее поле — «для разбора»
src/ui/pages/McpPage.tsx      # текущее содержание ресурса; пустое/ожидание/ошибка
tests/contract/agent-streamer.test.ts  # новый путь: сохранение, пусто, предел, токен
tests/worker/worker.test.ts   # MCP: перечень, чтение, пусто, без подстановки, смена текста
tests/unit/manage-page.test.tsx        # два поля
tests/unit/mcp-page.test.tsx           # содержимое/пусто/ошибка (новый)
tests/unit/pages-render.test.tsx       # раздел MCP по-прежнему открывается
```

**Structure Decision**: структура проекта не меняется. Поле живёт в существующей записи канала, путь — в существующем модуле настроек канала, ресурс — в существующем MCP-сервере. Программа конвейера в машине Upstash не затрагивается, поэтому порядок «сначала программа в бокс» здесь не нужен.

## Stages

| Этап | Что делается | Скиллы | Документация |
|---|---|---|---|
| 1. Задачи | Разбить план на задачи | `speckit-tasks`, `speckit-analyze` | — |
| 2. Поле и API | `Registry`: поле, чтение, запись; `PUT /api/agent-streamer`; контрактные проверки | `speckit-implement`, `upstash:upstash-redis-js` | [Upstash REST](https://upstash.com/docs/redis/features/restapi), [contracts/agent-streamer-api.md](./contracts/agent-streamer-api.md) |
| 3. Ресурс MCP | `capabilities.resources.listChanged: false`; `registerResource`; перечень на `server.server`; чтение с `ResourceNotFoundError`; проверки Worker'а | `speckit-implement`, `cloudflare:build-mcp`, `workers-best-practices` | [MCP resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources), [research.md](./research.md) §3–5, [contracts/mcp-resource.md](./contracts/mcp-resource.md) |
| 4. Страница | Второе поле в управлении; текущий текст в разделе MCP; состояния ожидания/ошибки; проверки разметки | `speckit-implement`, `shadcn` | [quickstart.md](./quickstart.md), существующие `HomePage`/`ManagePage` |
| 5. Проверки | `npm run typecheck`, `npx vitest run --project logic`, `npx vitest run --project workers`, `npm run build` | `speckit-implement` | [Vitest](https://v4.vitest.dev/llms.txt) |
| 6. Ревью и выпуск | Ревью по навыку, PR, слияние | `code-review`, `gh-cli` | — |
| 7. После выпуска | Живая страница и настоящий MCP-клиент: ресурс в перечне, чтение, пустое поле | `cloudflare` | [quickstart.md](./quickstart.md), «Проверки после выпуска» |

Слияние в основную ветку само выпускает сервис (`CLAUDE.md`). Программа конвейера не меняется: `npm run build:pipeline` и выкладка в машину не нужны. Этап 7 в список задач не входит — он про выпущенное.

## Риски

- **Замена обработчика перечня.** `McpServer.server.setRequestHandler("resources/list", …)` опирается на то, что низкоуровневый сервер заменяет обработчик без запрета (`dist/src-CX2iR2pK.mjs:6753-6775`) и что `McpServer` больше не переустанавливает его после регистрации ресурса. Обновление SDK может это изменить — проверки перечня и чтения поймают; правка сосредоточена в одном месте `mcp.ts`.
- **`listChanged` по умолчанию.** SDK объявляет `listChanged: true`, если возможность не задана (`dist/mcp-DXXb3Vv3.mjs:1497`). Передаём `false` явно; иначе клиент ждал бы уведомлений, которых сервер без состояния не шлёт.
- **Чтение записи в перечне и чтении.** Каждый запрос ресурса — одно обращение к реестру. Это не трогает инструменты: создание сервера реестр не читает, `search_knowledge` реестр не использует. Отказ реестра валит только ресурс — явной ошибкой, как требует FR-007.
- **Ошибка чтения на странице.** Сейчас `App` глотает ошибку и отдаёт `undefined`; без различения «не прочитано» и «не задано» раздел MCP сказал бы «ресурса нет» при недоступном хранилище. В план входит состояние загрузки/ошибки.
- **Публичность текста.** Новое поле видит любой посетитель страницы (публичный токен чтения) и любой MCP-клиент. Пояснение у поля прямо говорит об этом; сведений, которые нельзя показывать, в нём быть не должно.
- **Длинный текст.** До 20 000 знаков показываются целиком; вёрстка — обычный текст с сохранением переносов, без обрезки и без карточки.
- **Независимость полей.** Проверки: правка `streamerInfo` не меняет ресурс, правка `agentStreamerInfo` не меняет хеш инструкции разбора; `setChannel` не затирает новое поле.
- **Новый путь и токен.** `PUT /api/agent-streamer` повторяет защиту `PUT /api/streamer`; контрактные проверки — без токена, с чужим полем, с пустой строкой, с предельной длиной.
