---
description: "Задачи: общая информация о стримере как ресурс MCP"
---

# Tasks: Общая информация о стримере для ассистента как ресурс MCP

**Input**: Design documents from `specs/010-mcp-streamer-resources/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: проверки включены — этого требуют FR-005 и FR-007 (пустое поле и отказ хранилища), FR-009 (инструкция разбора не меняется) и конституция. Проверки пишутся до реализации и должны падать.

**Organization**: задачи сгруппированы по историям: US1 (клиент ассистента видит ресурс, P1) и US2 (владелец заполняет отдельное поле и видит результат, P2).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: можно делать параллельно (разные файлы, нет зависимости от незавершённых задач)
- **[Story]**: к какой истории относится задача
- Пути указаны от корня репозитория

---

## Phase 1: Setup

**Purpose**: убедиться, что исходное состояние зелёное

- [ ] T001 Прогнать `npx vitest run --project logic`, `npx vitest run --project workers`, `npm run typecheck`, `npm run build`; убедиться, что всё проходит до правок

---

## Phase 2: Foundational (блокирует обе истории)

**Purpose**: поле в записи канала, без которого не работает ни ресурс, ни страница

**⚠️ CRITICAL**: без этой фазы истории не начинать

- [ ] T002 [P] Написать падающую проверку в `tests/unit/registry-agent-info.test.ts`: `setAgentStreamerInfo` пишет только `agentStreamerInfo`; `getChannel` возвращает его; `setChannel` не затирает ни новое поле, ни `streamerInfo`; пустая строка сохраняется как пустая. Подменённый `fetch` — по образцу `tests/unit/registry-batch.test.ts`
- [ ] T003 В `src/shared/registry.ts`: добавить `agentStreamerInfo?: string` в `ChannelRecord`; читать `raw["agentStreamerInfo"]` в `getChannel`; добавить `setAgentStreamerInfo(info: string)` — `HSET` только этого поля; `setChannel` оставить поимённым и новое поле не трогать. Комментарии — по образцу `streamerInfo`

**Checkpoint**: поле хранится, читается и не затирается подключением канала

---

## Phase 3: User Story 1 - Клиент ассистента получает общую информацию о стримере (Priority: P1) 🎯 MVP

**Goal**: MCP-сервер отдаёт ресурс `streamer://info` из нового поля; пока поле пустое, ресурса нет.

**Independent Test**: в подставном реестре заполнено `agentStreamerInfo`; клиент через `InMemoryTransport` получает перечень из одного ресурса и читает сохранённый текст; после очистки поля перечень пуст, чтение отвечает отказом.

### Tests for User Story 1

- [ ] T004 [P] [US1] Написать падающие проверки в `tests/worker/worker.test.ts` (клиент `@modelcontextprotocol/client` через `InMemoryTransport`, `FakeRegistry`): заполненное `agentStreamerInfo` — `resources/list` содержит ровно один ресурс `streamer://info` с name/title/description/mimeType; `readResource` отдаёт текст без краевых пробелов и без обёртки; пустое поле — список пуст, чтение отвечает ошибкой; `streamerInfo` заполнено, `agentStreamerInfo` пусто — ресурса нет; смена текста между чтениями видна; на `resources/list` и `resources/read` — по одному обращению к реестру. Использовать `seededRegistry` и `registry.hash("channel").set(...)`

### Implementation for User Story 1

- [ ] T005 [US1] В `src/worker/mcp.ts`: создать `McpServer` с `capabilities: { resources: { listChanged: false } }`; зарегистрировать `streamer://info` (name `streamer_info`, title «Общая информация о стримере», description «Кто такой стример и о чём канал: общие сведения для ассистента», `mimeType: "text/plain"`); в чтении брать `agentStreamerInfo` из `getChannel`, `trim`, при пустом — `ResourceNotFoundError(uri.href)`, иначе `{ contents: [{ uri, mimeType: "text/plain", text }] }`. Заменить `server.server.setRequestHandler("resources/list", …)`: читает канал, при пустом поле — `{ resources: [] }`, иначе один ресурс с теми же метаданными. Импортировать `ResourceNotFoundError`; инструменты и их ответы не менять
- [ ] T006 [US1] Прогнать `npx vitest run --project workers`; убедиться, что новые проверки проходят, прежняя проверка `list_streams` и остальные не изменились. При падении исправлять реализацию, а не ожидания

**Checkpoint**: US1 работает и проверена независимо; инструменты не тронуты

---

## Phase 4: User Story 2 - Владелец заполняет отдельное поле и видит, что получает ассистент (Priority: P2)

**Goal**: в управлении два разных поля; новое сохраняется своим путём; раздел MCP показывает текущий текст ресурса, пустое состояние и отказ чтения.

**Independent Test**: контракт `PUT /api/agent-streamer` сохраняет текст и не трогает поле для разбора; страница управления показывает два поля с разными названиями; раздел MCP показывает сохранённый текст, а при пустом поле — сообщение и указание, где заполнить.

### Tests for User Story 2

- [ ] T007 [P] [US2] Написать падающий контракт `tests/contract/agent-streamer.test.ts` по образцу `tests/contract/streamer.test.ts`: `handleSetAgentStreamer` сохраняет текст дословно; пустая строка сохраняется; текст до 20 000 знаков принимается; без токена — `unauthorized`; тело без `info` — `invalid_input`; вызов не трогает `setStreamerInfo`
- [ ] T008 [P] [US2] Дополнить `tests/unit/manage-page.test.tsx`: у канала с заполненным `agentStreamerInfo` видны два поля с разными названиями и пояснениями; при пустом поле новое поле присутствует и объясняет, куда идёт текст; прежнее поле названо как поле для разбора
- [ ] T009 [P] [US2] Создать `tests/unit/mcp-page.test.tsx`: с заполненным `channel.agentStreamerInfo` виден текст; с пустым — сообщение «ресурса нет» и указание, где заполнить; с ошибкой чтения — `Alert`; при загрузке — `Skeleton`

### Implementation for User Story 2

- [ ] T010 [US2] В `src/worker/routes/channel.ts` добавить `handleSetAgentStreamer`: тот же `{ info }`, предел `MAX_STREAMER_INFO_CHARS` (20 000), `requireAdminToken`, `parseJson`, `services.registry.setAgentStreamerInfo`; в `src/worker/index.ts` добавить маршрут `PUT /api/agent-streamer`
- [ ] T011 [P] [US2] В `src/ui/lib/registry.ts`: добавить `agentStreamerInfo?: string` в `ChannelSummary` и читать `map.get("agentStreamerInfo")` в `getChannel`
- [ ] T012 [US2] В `src/ui/App.tsx`: различать «канал прочитан», «канала нет» и «ошибка чтения»; передать `channel`, `loaded`, `error` в `McpPage`; `onChanged` по-прежнему обновляет канал
- [ ] T013 [US2] В `src/ui/pages/ManagePage.tsx`: второе поле «Общая информация о стримере для ассистента» с пояснением, что текст видят все и на разбор он не влияет; прежнее поле — «Сведения о стримере для разбора» с пояснением, что ассистент его не получает; сохранять через `/api/agent-streamer`; добавить `"agent"` в `busy`, `message`, `outcome`; показывать сохранённое значение из `channel.agentStreamerInfo`
- [ ] T014 [US2] В `src/ui/pages/McpPage.tsx`: принять `channel`, `loaded`, `error`; показать название ресурса и текущий текст (`whitespace-pre-wrap`); при пустом поле — сообщение, что ресурса нет, и ссылку на `/manage`; при загрузке — `Skeleton`; при ошибке — `Alert`
- [ ] T015 [US2] Прогнать новые проверки; убедиться, что сохранение поля и чтение ресурса дают один и тот же текст, а прежние проверки инструментов и разбора остаются зелёными
- [ ] T016 [P] [US2] Написать текст общей информации о 5opka в `specs/010-mcp-streamer-resources/streamer-info.md`: кто он, о чём канал, постоянные собеседники и свои словечки; только открытые сведения, без того, что нельзя показывать; текст для ассистента, а не список исправлений распознавания. Опереться на `specs/002-document-quality/streamer-info.md` и открытые источники. Сохранение текста в поле — после выпуска (действие над боевыми данными, в задачи не входит)

**Checkpoint**: обе истории работают независимо; сохранил текст — ассистент его получает

---

## Phase 5: Polish

- [ ] T017 [P] Прогнать `npm run typecheck`, `npx vitest run --project logic`, `npx vitest run --project workers`, `npm run build`
- [ ] T018 Пройти [quickstart.md](./quickstart.md) без частей, требующих развёрнутого сервиса: автоматические проверки и сборка
- [ ] T019 Ревью по навыку `code-review`, затем коммит и Pull Request в `main` (`gh-cli`). Программа конвейера не меняется: `npm run build:pipeline` и выкладка в машину не нужны

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: ни от чего не зависит
- **Foundational (Phase 2)**: после Setup; блокирует обе истории
- **US1 (Phase 3)**: после Foundational
- **US2 (Phase 4)**: после Foundational; контракт и разметка страниц от US1 не зависят, но проверка «сохранил — ресурс отдал» (T015) требует US1; текст о 5opka (T016) от кода не зависит
- **Polish (Phase 5)**: после обеих историй

### Within Each Story

- Проверки пишутся до реализации и должны падать (T002 до T003; T004 до T005; T007–T009 до T010–T014)
- Ресурс (T005) до проверки связи с сохранением (T015)
- Поле в `ChannelSummary` (T011) до страниц (T012–T014)
- Текст о 5opka (T016) можно писать параллельно с кодом: он не зависит от реализации

### Parallel Opportunities

- T002 и T003 — разные файлы, но T003 делает проверку зелёной; писать по порядку
- T004, T007, T008, T009 — разные файлы проверок; можно писать параллельно
- T010, T011, T013, T016 — разные файлы; T012 и T014 связаны общим интерфейсом `McpPage`, выполнять последовательно
- T017 — после всех правок

---

## Implementation Strategy

### MVP First (User Story 1)

1. T001 → T002, T003 → T004–T006
2. Остановиться и проверить US1 отдельно: в подставном реестре заполнено поле — клиент видит и читает ресурс, пустое поле — ресурса нет
3. После этого — US2

### Incremental Delivery

1. Foundational + US1 → ресурс работает, инструменты не тронуты
2. US2 → владелец заполняет поле на странице, раздел MCP показывает текст; текст о 5opka написан (T016)
3. Polish → типы, проверки, сборка, ревью, PR

### Проверки после выпуска

В список задач не входят (про то, что выпущенное работает): раздел «Проверки после выпуска» в [quickstart.md](./quickstart.md) — живая страница и настоящий MCP-клиент, а также сохранение текста из [streamer-info.md](./streamer-info.md) в поле `agentStreamerInfo`. Проверка на тестовой копии Worker'а тоже требует развёрнутого сервиса и в задачи не входит.

---

## Notes

- [P] — разные файлы, нет зависимости от незавершённых задач
- Проверки обязательны: FR-005/FR-007 (пустое поле и отказ хранилища) и FR-009 (инструкция разбора не меняется)
- Текст о 5opka — из открытых источников, без того, что нельзя показывать; он для ассистента, а не для разбора
- Программа конвейера в машине Upstash не меняется, порядок «сначала программа в бокс» не нужен
- Коммит после каждой логической группы; слияние в `main` выпускает сервис
