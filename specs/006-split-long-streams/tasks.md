---

description: "Задачи: длинный эфир разбирается по частям"
---

# Tasks: Длинный эфир разбирается по частям

**Input**: `specs/006-split-long-streams/` — [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Prerequisites**: plan.md, spec.md (есть); research.md, data-model.md, contracts/ (есть)

**Tests**: план (этап И9) прямо требует проверок, поэтому тесты включены. Внутри каждой истории они идут первыми и до реализации должны падать.

**Организация**: по историям пользователя. Приёмочные проверки на развёрнутом сервисе в список не входят — они в [quickstart.md](./quickstart.md) и делаются после выпуска.

## Формат: `[ID] [P?] [Story] Описание с путём файла`

- **[P]**: можно выполнять параллельно (другие файлы, нет зависимости от незавершённых задач)
- **[Story]**: к какой истории относится задача (US1, US2, US3)
- Пути — от корня репозитория

## Соглашения, общие для всех задач

- **Идентификатор записи** (`streamId`) — ключ реестра, имя объекта документа, префикс векторов, адрес страницы, имя прогона. Образец `^\d{1,20}(-p\d{1,3})?$`; у неделёной записи он равен номеру записи площадки (`vodId`), у части — `<vodId>-p<номер части>`, нумерация с единицы. Строки вида `` `${vodId}-p${n}` `` вне `src/shared/stream-id.ts` запрещены.
- **`vodId`** после этой работы означает только номер записи на площадке: по нему идут обращения к Twitch и строятся ссылки на момент эфира. Ключом он больше не служит.
- **Время внутри части — абсолютное**, от начала эфира: метки кусков, границы разделов, `startSeconds` и `endSeconds` в документе и в метаданных знаний.
- **ПОРОГ = 6 часов (21 600 с)**, **длина куска аудио = 20 минут (1 200 с)**. Оба числа — в одном месте (`src/shared/stream-parts.ts`) с комментарием-расчётом из [research.md](./research.md) §2: они выведены из лимита в 50 внешних обращений на прогон и меняются вместе.
- **Скиллы по этапам** ([research.md](./research.md) §8, конституция, принцип I): Worker и Workflows — `workers-best-practices`, `cloudflare`; реестр — `upstash-redis-js`; векторная база — `upstash-vector-js`; документы — `upstash-blob-js`; конвейер — `upstash-box-js`; страница — `shadcn`. Перед этапом — загрузить скилл и сверить решение с документацией.
- Промежуточная сборка внутри фазы 2 не обязана проходить: `StreamRecord` меняется сразу у всех вызывающих. Проходит она на контрольной точке в конце фазы.

---

## Phase 1: Setup

**Purpose**: зафиксировать исходное состояние, чтобы отличать свои поломки от прежних.

- [X] T001 На ветке `006-split-long-streams` выполнить `npm ci`, `npm run typecheck`, `npm test`; убедиться, что всё зелёное до правок. Если что-то красное — записать что именно в `specs/006-split-long-streams/research.md` §9 и не считать своим.

---

## Phase 2: Foundational (блокирует все истории)

**Purpose**: идентификатор части, деление эфира и поведенчески нейтральный переход ключей записи с `vodId` на `streamId`. После этой фазы система работает как раньше: у каждой записи `streamId` равен `vodId`, частей нет.

**⚠️ CRITICAL**: ни одна история не начинается, пока не пройдена контрольная точка T017.

- [X] T002 [P] Создать `src/shared/stream-id.ts`: экспортировать `STREAM_ID_PATTERN = /^\d{1,20}(-p\d{1,3})?$/`, `formatStreamId(vodId: string, part?: number): string`, `parseStreamId(value: string): { vodId: string; part?: number }`, `isStreamId(value: string): boolean`. `parseStreamId("2878430068")` → `{ vodId: "2878430068" }` (без ключа `part`), `parseStreamId("2878430068-p2")` → `{ vodId: "2878430068", part: 2 }`; всё, что не подходит под образец, и часть `p0` — `AppError("invalid_input", …)` с текстом для человека (по образцу `src/shared/errors.ts`). `formatStreamId` тоже отвергает часть меньше 1.
- [X] T003 [P] Создать `tests/unit/stream-id.test.ts` (Vitest, логика без сети): разбор и сборка туда и обратно; старый вид без суффикса; отвергаются пустая строка, `abc`, `123-p`, `123-p0`, `123-p1000`, `../123`, `123/p2`, `123-p2-p3`, 21 цифра; длина имени прогона `ingest-<streamId>-<runId>` при самом длинном `streamId` (20 цифр + `-p999` = 25 знаков) и `runId` в 64 знака укладывается в 100 символов и в образец `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`.
- [X] T004 [P] Создать `src/shared/stream-parts.ts`: экспортировать `MAX_PART_SECONDS = 6 * 3600`, `AUDIO_CHUNK_SECONDS = 20 * 60` (рядом, с комментарием-расчётом по [research.md](./research.md) §2: формула `N + P + 2×B + 8`, шестичасовая часть — 39 обращений из 50, худшее сочетание — 46) и чистую функцию `splitIntoParts(durationSeconds: number): StreamPart[]`, где `StreamPart = { index: number; count: number; startSeconds: number; endSeconds: number }`. Правило: `count = ceil(длительность / ПОРОГ)`, при длительности не больше порога (включая 0) — одна часть `{1, 1, 0, длительность}` (граница включающая); иначе `startSeconds(i) = floor((i − 1) × D / count)`, `endSeconds(i) = floor(i × D / count)`, последняя часть заканчивается ровно на `D`, части равны с точностью до секунды. Отрицательная или нечисловая длительность — `RangeError`.
- [X] T005 [P] Создать `tests/unit/stream-parts.test.ts`: ровно 6 ч → одна часть; 6 ч 1 с → две по ≈3 ч, а не шесть часов и секунда; 6 ч 1 мин → две по ≈3 ч; 12 ч → две по 6 ч; 15 ч → три по 5 ч; 9 ч → две; границы стыкуются без дыр и наложений (`part[i].endSeconds === part[i+1].startSeconds`), сумма длин равна `D`, ни одна часть не длиннее `MAX_PART_SECONDS`; число частей — наименьшее из возможных; `AUDIO_CHUNK_SECONDS` делит `MAX_PART_SECONDS` без остатка. Охрана связи порога и куска с лимитом платформы: расчёт по формуле [research.md](./research.md) §2 (`N + P + 2×B + 8`; `P = ceil(минут × знаков в минуту ÷ 30 000)`, `B = ceil(минут × 0,2 ÷ 32)`), где `N = MAX_PART_SECONDS ÷ AUDIO_CHUNK_SECONDS`, даёт при 579 знаках в минуту 39, при 900 плюс два повтора и одна уборка — 46, и то и другое не больше 50. Числа 30 000, 32, 0,2, 579 и 900 в тесте заданы константами с пометкой «скопировано из `src/worker/workflow.ts` и [research.md](./research.md) §2, при изменении — пересчитать»: `workflow.ts` под Node не подключается.
- [ ] T006 Обновить `src/shared/registry.ts`: в `StreamRecord` добавить `streamId: string` (ключ; в хеше отдельным полем не хранится) и необязательные `part?: number`, `partCount?: number`, `partStartSeconds?: number` — «только у части»; `vodId` остаётся и в хеше хранит номер записи площадки. Ключ `stream:${streamId}` и член индекса `streams:index` — `streamId`. Переименовать параметры `getStream`, `claimForIngest`, `patchStream`, `removeStream` в `streamId`; `knownVodIds()` → `knownStreamIds()` (приведение к строке остаётся: см. комментарий в файле). `toStreamRecord(raw, streamId)` берёт `streamId` из ключа; `putStream` пишет `part`, `partCount`, `partStartSeconds` только когда они заданы; чтение нового поля в `toStreamRecord` — через `optionalNumber`. `skippedStreamRecord(video, …)` ставит `streamId = video.vodId`. Обновить `tests/unit/registry-ids.test.ts` (переименование метода) и добавить в него случай: запись с полями части читается обратно с `part`, `partCount`, `partStartSeconds`, а без них — эти поля отсутствуют.
- [ ] T007 [P] Обновить `src/shared/documents.ts`: параметр `vodId` → `streamId` во всех методах, `Documents.path(streamId)` = `streams/<streamId>.md`. Многочастную запись (`multipart: true`) **не трогать**: см. T050.
- [ ] T008 [P] Обновить `src/shared/knowledge.ts` и `src/shared/chunks.ts`: `ChunkMetadata` получает `streamId: string` — запись, которой принадлежит кусок; `vodId` остаётся и означает только номер записи площадки. `ChunkToIndex` и `ChunkSource` получают `streamId`. `chunkId(streamId, sectionIndex, chunkIndex)` = `<streamId>:<номер раздела>:<номер куска>`. `search` группирует куски в раздел по `` `${metadata.streamId ?? metadata.vodId}:${sectionIndex}` `` (у старых векторов поля `streamId` нет, для них он равен `vodId`); в `FoundSection.stream` добавить `streamId`, а `id` строить от него же. `removeStream`, `removeExcept`, `renameStream` принимают `streamId`. В `buildChunks` ссылка `url` строится по `vodId` и абсолютному `startSeconds` (`vodUrlAt` не меняется). Обновить `tests/contract/knowledge-search.test.ts` и `tests/unit/document-naming.test.ts`.
- [ ] T009 [P] Обновить `src/shared/box.ts`: `startIngest({ streamId, url, callbackUrl, fromSeconds, toSeconds })`; `requireVodId` заменить на `requireStreamId` по `STREAM_ID_PATTERN` (значение уходит в командную оболочку бокса и в имя журнала — проверка остаётся строгой, дефис и буква `p` допустимы, больше ничего); `fromSeconds` и `toSeconds` — целые неотрицательные числа, `fromSeconds < toSeconds`, иначе `AppError("invalid_input")`. `buildIngestCommand` передаёт `--stream '<streamId>' --from <N> --to <M>` и называет журнал `ingest-<streamId>-<attempt>.log`. Обновить `tests/unit/box-args.test.ts`: выход из каталога журнала, слэш, точка, `123-p`, `123-p0` отвергаются; `123-p2` принимается; нецелые, отрицательные и `from >= to` отвергаются.
- [ ] T010 [P] Обновить `src/worker/schedule.ts` и `src/worker/naming.ts` под `streamId` без изменения поведения: `known` — `Map<streamId, StreamRecord>` по `knownStreamIds()`; `selectNextVideo` и `unprocessableToSkip` ищут запись по `video.vodId` (пока равен `streamId`); `retireExhausted` и `patchStream` — по `streamId`; `startStreamIngest(next.vodId, …)` пока как есть. В `naming.ts` — `record.streamId` вместо `record.vodId` (документ, векторы, реестр, `sessionId`). Привести `tests/unit/schedule-select.test.ts`, `tests/unit/schedule-skip.test.ts`, `tests/unit/document-naming.test.ts` к новым названиям (`streamId` в фикстурах записей, `knownStreamIds` в заглушке реестра).
- [ ] T011 [P] Обновить `src/worker/routes/streams.ts` и `src/worker/index.ts`: маршруты `/api/streams/:streamId/document`, `/api/streams/:streamId/reparse`, `/api/streams/:streamId`; в начале `handleGetDocument`, `handleReparseStream`, `handleDeleteStream` идентификатор проходит `parseStreamId` — неподходящий отвергается ошибкой `invalid_input` **до обращения к любому хранилищу** (сегодня три из четырёх путей формат не проверяют вовсе, а удаление сносит векторы по префиксу). Внутри — `streamId` вместо `vodId`; ответ удаления и запуска отдаёт и `streamId`, и `vodId`. `startStreamIngest(streamId, …)` принимает `streamId` и пока трактует его как номер записи; передаёт боксу `fromSeconds: 0`, `toSeconds: video.durationSeconds`. Обновить `tests/contract/streams.test.ts` и `tests/worker/worker.test.ts`: мусорный идентификатор — 400 без единого обращения к сети.
- [ ] T012 [P] Обновить `src/worker/routes/internal.ts` и `src/worker/env.ts`: `IngestParams` получает `streamId`, `partStartSeconds: number` (0 у неделёной) и необязательный `part?: { index: number; count: number }`; `vodId` остаётся. `IngestReadyBody` и `IngestFailedBody` получают необязательные `streamId` и `partStartSeconds`; сигнал прежней программы (без них) читается как неделёная запись: `streamId = vodId`, начало 0. Значение `streamId` из сигнала проходит `parseStreamId`, а его `vodId` обязан совпасть с полем `vodId` тела. `workflowInstanceId(streamId, runId)` = `ingest-<streamId>-<runId>`; `instanceStarted`, `patchStream`, `putStream`, `goneForGood(parsed.vodId)` — по `streamId` там, где нужен ключ, и по `vodId` там, где обращение к площадке. Обновить `tests/contract/internal.test.ts`: сигнал прежнего вида работает как раньше, сигнал с `streamId` без суффикса — тоже.
- [ ] T013 Обновить `src/worker/workflow.ts`: `params.streamId` вместо `params.vodId` в ключах `transcript/<streamId>/chunk-NNNN.txt` и `transcript/<streamId>/full.txt`, в `sessionId`, в `patchStream`, `Documents.path`, `chunkId`, `removeExcept`, `isAlreadyFinished`, `cleanupTemporary` (префикс `${prefix}${streamId}/`), в журнале; в `buildChunks` — `stream: { streamId, vodId, publishedAt }`. Поведение прежнее.
- [ ] T014 [P] Обновить `src/worker/mcp.ts`: в `structuredContent.streams[]` добавить `streamId`; `vodId` остаётся и означает номер записи площадки.
- [ ] T015 [P] Создать `src/pipeline/args.ts` (разбор аргументов; `main.ts` исполняется при импорте и не проверяется) и перевести на него `src/pipeline/main.ts` и `src/pipeline/publish.ts`: `parseArgs(argv)` принимает `--stream`, `--url`, `--callback`, `--from`, `--to`; **прежние аргументы тоже**: `--vod` читается как `--stream`, отсутствующие `--from` и `--to` означают весь эфир (конвейер подставляет `0` и длительность из `readMediaInfo`) — порядок выпуска кладёт программу в бокс раньше сервиса ([contracts/pipeline.md](./contracts/pipeline.md)). Значение `--stream` проходит `STREAM_ID_PATTERN`, `--from` и `--to` — целые неотрицательные. Если аргументы не разобрались, сообщить Worker об отказе некому (не известен даже идентификатор): программа пишет причину в журнал и завершается с кодом 1 — этот случай возможен только при ручном запуске, сервис всегда передаёт корректные значения (T009), а прежние аргументы принимаются как раз затем, чтобы окно между укладкой программы и выпуском сервиса не оставляло запись в `processing` на сутки. `audioKey(streamId, index)` = `audio/<streamId>/chunk-NNNN.m4a`; рабочий каталог `/workspace/home/work/<streamId>`; в сигнал готовности и отказа добавить `streamId`; `vodId` оставить.
- [ ] T016 Перевести страницу на `streamId` без изменения поведения: `src/ui/lib/registry.ts` — `StreamSummary` получает `streamId` (из члена индекса) и `vodId` (из поля хеша, при его отсутствии равен `streamId`), `toSummary(fields, streamId)`, `listStreams` передаёт идентификаторы из `ZRANGE`; `src/ui/components/StreamList.tsx`, `StreamActions.tsx`, `src/ui/pages/KnowledgePage.tsx`, `src/ui/components/DocumentView.tsx`, `src/ui/App.tsx` — `streamId` вместо `vodId` в ключах списка, вызовах `onOpen/onReparse/onDelete`, адресах `/api/streams/<streamId>/…`; `src/ui/lib/routes.ts` — образец адреса документа `^\/knowledge\/(\d{1,20}(?:-p\d{1,3})?)$` (общий с `STREAM_ID_PATTERN`, без копирования регулярного выражения: импорт из `@/shared/stream-id.ts`), поле `Matched.streamId`, `knowledgeDocumentPath(streamId)`. Обновить `tests/unit/routes.test.ts`, `tests/unit/stream-actions.test.tsx`, `tests/unit/stream-list-read.test.ts`, `tests/unit/manage-page.test.tsx`, `tests/unit/pages-render.test.tsx`, `tests/e2e/interface-truth.e2e.ts`.
- [ ] T017 **Контрольная точка**: `npm run typecheck`, `npm test`, `npm run build`, `npm run build:pipeline` проходят; поведение системы не изменилось (частей нет, `streamId` равен `vodId` везде).

**Checkpoint**: основание готово — истории можно начинать.

---

## Phase 3: User Story 1 — Длинный эфир разбирается целиком (Priority: P1) 🎯 MVP

**Goal**: запись длиннее шести часов делится по времени на равные части; каждая часть проходит путь обычной записи целиком (свой прогон конвейера, свой прогон разбора, своя запись реестра, свой документ) и укладывается в 50 обращений; ссылка из любой части ведёт на нужный момент исходной записи; части видны в списке.

**Independent Test**: запись длиннее порога, поданная в отбор, даёт по одной записи реестра на часть, каждая часть получает свой запуск конвейера с границами отрезка, время в её документе и знаниях абсолютное, а список показывает части подряд и по порядку. Эфир ровно в шесть часов остаётся одной записью.

### Tests for User Story 1 ⚠️ (писать первыми; до реализации должны падать)

- [ ] T018 [P] [US1] `tests/unit/schedule-select.test.ts`: приспособить `selectNextVideo` под возвращаемое `{ video, part }` и добавить случаи — эфир 7 ч без записей в реестре → берётся первая часть; первая часть `ready` → берётся вторая; обе `ready` → ничего; в реестре есть неделёная запись `X` (любого состояния) и эфир делимый → эфир автоматикой не берётся (FR-015: не задним числом); эфир ровно 6 ч → одна часть, `streamId` без суффикса; из двух эфиров раньше берётся тот, чья часть начинается раньше (`publishedAtUnix + startSeconds`); правило `watchFrom` смотрит на эфир, а не на часть; идущий эфир (`liveStreamId`) по-прежнему пропускается; функция `knownVideoIds(known)` (см. T029) возвращает номера записей площадки по всем записям реестра, в том числе по частям.
- [ ] T019 [P] [US1] `tests/unit/pipeline-range.test.ts`: `clipChapters` обрезает главы по отрезку `[from, to]` и оставляет время абсолютным (глава, начавшаяся до отрезка, начинается в `from`; глава вне отрезка отбрасывается; нет ни одной — одна пустая глава на весь отрезок); `absoluteChunks` прибавляет `from` к `offsetSeconds` каждого куска; `formatSection(from, to)` даёт `*HH:MM:SS-HH:MM:SS` (`*01:00:00-01:32:00`, как в замере [research.md](./research.md) §5); `parseArgs` из `src/pipeline/args.ts` — новые аргументы, прежние `--vod` без `--from/--to`, отказ на `--stream '1;rm -rf /'`, на `--from 5 --to 5`, на нецелых.
- [ ] T020 [P] [US1] `tests/unit/document-range.test.ts`: `planDocumentParts` и `findCoverageGaps` (после переноса, T027) на отрезке, начинающемся не с нуля (например, `[21600, 43200]`): границы проходов лежат внутри отрезка и стыкуются, первый проход начинается в `21600`; покрытие, сплошь заполняющее отрезок, разрывов не даёт; отсутствие покрытия в первые полчаса части — один разрыв от `21600`, а не от нуля; отрезок с нуля ведёт себя как раньше.
- [ ] T021 [P] [US1] `tests/unit/part-label.test.ts`: `withPartLabel("Как разыграли зрителей", { index: 2, count: 3 })` = `Как разыграли зрителей (часть 2 из 3)`; без части имя возвращается как есть; повторный вызов на уже помеченном имени метку не удваивает.
- [ ] T022 [P] [US1] `tests/contract/internal.test.ts`: сигнал готовности с `streamId: "<vod>-p2"`, `partStartSeconds: 21600` создаёт экземпляр `ingest-<vod>-p2-<runId>`; в `params` — `streamId`, `vodId`, `partStartSeconds`, `part: { index: 2, count: N }` (число частей — из записи реестра, положенной при запуске), `publishedAt` = время эфира плюс `partStartSeconds`, `durationSeconds` — длина части; запись реестра `stream:<vod>-p2` содержит `part`, `partCount`, `partStartSeconds`, `vodId`, `publishedAtUnix` = время эфира + начало части; сигнал с `streamId`, чей `vodId` не совпадает с полем `vodId`, отвергается; сигнал для части, которой нет в реестре, отвергается `invalid_input`.
- [ ] T023 [P] [US1] `tests/unit/list-order.test.ts`: `orderForList` (T034) — эфиры от новых к старым, части внутри эфира по номеру (первая первой), неделёные записи между эфирами встают по времени эфира; запись без `part` и запись с `part: 1` одного `vodId` рядом не встречаются (разные записи разного вида одного эфира невозможны — но функция не падает).

### Implementation for User Story 1

- [ ] T024 [P] [US1] `src/pipeline/media.ts`: добавить чистую `clipChapters(chapters: Chapter[], fromSeconds: number, toSeconds: number): Chapter[]` — главы обрезаются по отрезку, время остаётся абсолютным; если ни одна глава не пересекла отрезок, возвращается одна `{ title: "", startSeconds: from, endSeconds: to }`.
- [ ] T025 [US1] `src/pipeline/segment.ts`: удалить `CHUNK_SECONDS = 600` и брать `AUDIO_CHUNK_SECONDS` из `src/shared/stream-parts.ts` (комментарий в шапке файла: куски по двадцать минут, замер 11,7 с при лимите провайдера 60 с — [research.md](./research.md) §3). `cutAudio(url, workDir, range)` добавляет в команду `yt-dlp` аргумент `--download-sections` со значением `formatSection(from, to)` — **без** `--force-keyframes-at-cuts` (замер: процессорное время вдвое больше, [research.md](./research.md) §5). Экспортировать `formatSection` и `absoluteChunks(chunks, fromSeconds)`: смещения кусков после нарезки прибавляют `from`, потому что нарезка отрезка считает время от нуля.
- [ ] T026 [US1] `src/pipeline/main.ts`: `range = { from: args.from ?? 0, to: min(args.to ?? info.durationSeconds, info.durationSeconds) }`; `from >= to` — отказ (`Error`, код `download_failed` по `classifyFailure`), сообщённый Worker обычным путём; `cutAudio(url, workDir, range)`; куски проходят `absoluteChunks`; в сигнал готовности: `durationSeconds = to − from` (длина отрезка, а не всего эфира), `categories = clipChapters(info.chapters, from, to)`, `partStartSeconds = from`, `streamId`, `vodId` (из `parseStreamId`). Рабочий каталог и журнал — по `streamId`.
- [ ] T027 [P] [US1] `src/shared/categories.ts`: `planDocumentParts(range: { startSeconds; endSeconds }, chapters, partCount)` вместо длительности (идеальная граница `range.startSeconds + idealSpan × index`, кандидаты — только главы строго внутри отрезка, первый проход начинается в `range.startSeconds`, последний заканчивается в `range.endSeconds`); перенести сюда `findCoverageGaps(sections, range)` из `src/worker/workflow.ts` (сегодня курсор стоит на нуле, и у части, начинающейся не с нуля, весь отрезок до её начала объявился бы разрывом) и экспортировать; в `workflow.ts` импортировать оттуда. Функции не должны требовать `cloudflare:workers`, чтобы проверяться под Node.
- [ ] T028 [P] [US1] `src/shared/document-name.ts`: добавить `withPartLabel(name: string, part?: { index: number; count: number }): string` — `<имя> (часть N из M)`; у неделёной записи имя не меняется; уже помеченное имя не помечается повторно. Метка ставится в коде, а не просится у модели: FR-005 требует, чтобы имя называло часть, и полагаться на послушность ответа для этого нельзя.
- [ ] T029 [US1] `src/worker/schedule.ts`: `selectNextVideo(videos, known, watchFrom, nowUnix, liveStreamId?)` возвращает `{ video: TwitchVideo; part: StreamPart } | undefined`. Для каждого эфира: `parts = splitIntoParts(video.durationSeconds)`; если частей одна — как раньше (запись `streamId = vodId`); если несколько — при наличии в `known` неделёной записи `video.vodId` эфир автоматикой не берётся (FR-015), иначе кандидаты — части по `formatStreamId(vodId, part.index)` с прежними правилами состояния (`ready`/`skipped` — нет; `processing` — только устаревшая; `failed` — пока `attempts < MAX_ATTEMPTS`; новой — если эфир после `watchFrom`). Из кандидатов берётся с наименьшим `video.publishedAtUnix + part.startSeconds`. Экспортировать `knownVideoIds(known): Set<string>` (номера записей площадки по `record.vodId`) и использовать в `stopAt` обхода архива вместо `known.has(video.vodId)` — иначе обход не остановится на известном делёном эфире и каждый час пройдёт все пять страниц. `runScheduledCheck` передаёт `startStreamIngest` идентификатор выбранной части и её `attempts` как `previousAttempts`. `unprocessableToSkip` продолжает помечать пропущенным эфир целиком (неделёной записью).
- [ ] T030 [US1] `src/worker/routes/streams.ts`, `startStreamIngest(streamId, source, services, callbackBaseUrl, previousAttempts)`: `parseStreamId` → `getVideo(vodId)` → `skipReason` (правило 003 смотрит на эфир целиком; запись пропущенного эфира — неделёная, `streamId = vodId`) → `parts = splitIntoParts(video.durationSeconds)`. Часть определяется так: для `streamId` с суффиксом — эта часть, при этом эфир обязан делиться и номер не больше числа частей, иначе `invalid_input` («У этого эфира нет такой части»); для `streamId` без суффикса на делимом эфире — первая часть, чья запись не `ready` и не занята (все `ready` — `already_processed`; все, что не `ready`, заняты — `busy`); на неделимом — сам эфир. Занятие (`claimForIngest`) — по `streamId` части. В `putStream` — `streamId`, `vodId`, `part`, `partCount`, `partStartSeconds`, `durationSeconds = длина части`, `publishedAtUnix` и `publishedAt` = время эфира плюс `partStartSeconds` (и ISO-строка того же момента); у неделёной записи `part*` не пишутся. Боксу — `fromSeconds = part.startSeconds`, `toSeconds = part.endSeconds`. Неделёная запись `video.vodId`, оставшаяся от прежней версии у теперь делимого эфира, удаляется (реестр, векторы `<vodId>:`, документ) **после** занятия первой части — чтобы сорвавшийся запуск не терял прежнее. Тип `IngestOutcome`: `{ status: "processing"; streamId: string; part?: { index; count } } | { status: "skipped"; reason: string }`; ответ `respondToIngest` и `handleAddStream` отдают `streamId`, `vodId` и, если эфир поделён, `part` и `partCount` — владелец, добавивший девятичасовой эфир, видит, что взята первая часть из двух.
- [ ] T031 [US1] `src/worker/routes/internal.ts`, `handleIngestReady`: `streamId = payload.streamId ?? payload.vodId` (проверка — T012); `partStartSeconds = payload.partStartSeconds ?? 0`; `existing = getStream(streamId)` — у части запись обязана существовать (её положил запуск), иначе `invalid_input`; `part`/`partCount` берутся из `parseStreamId` и записи. `params.publishedAt` и запись реестра — время эфира из сигнала плюс `partStartSeconds` (ISO и `publishedAtUnix`); `durationSeconds` — как пришло (длина отрезка); `params.part = { index, count }` только у части; в запись реестра `part`, `partCount`, `partStartSeconds` — только у части. Имя экземпляра — `workflowInstanceId(streamId, runId)`, длина до 100 знаков (проверено в T003).
- [ ] T032 [US1] `src/worker/workflow.ts` и `src/worker/env.ts`: диапазон разбора `range = { startSeconds: params.partStartSeconds, endSeconds: params.partStartSeconds + params.durationSeconds }`; `planDocumentParts(range, params.categories, partCount)` и `findCoverageGaps(sections, range)` (T027) вместо длительности; в `renderDocumentHeader` длительность — длина части; `docTitle = withPartLabel(name, params.part)` после `composeDocumentName` (T028) — имя идёт и в шапку документа, и в метаданные кусков, и в реестр; в `docPath` — `Documents.path(params.streamId)`. Смещение кусков в Worker **не прибавляется**: они приходят абсолютными ([research.md](./research.md) §7). Комментарий в шапке файла про «семичасовой эфир и сорок кусков» привести к действительности (шестичасовая часть, 18 кусков).
- [ ] T033 [P] [US1] `src/worker/naming.ts`: `nameOne` для записи с `part` и `partCount` оборачивает выработанное имя в `withPartLabel` перед записью в документ, метаданные и реестр.
- [ ] T034 [P] [US1] `src/ui/lib/registry.ts`: `StreamSummary` получает `part?`, `partCount?`, `partStartSeconds?`, `publishedAtUnix` (читаются из хеша через `Number`, как остальные числа: клиент этого файла — голый REST, значения приходят строками); экспортировать `orderForList(streams): StreamSummary[]` — эфиры от новых к старым по `publishedAtUnix − (partStartSeconds ?? 0)`, части внутри эфира по возрастанию `part`; `listStreams` возвращает результат `orderForList`. Индекс читается от новых к старым, и без этой сортировки вторая часть стояла бы выше первой (FR-011).
- [ ] T035 [US1] `src/ui/lib/format.ts` и `src/ui/components/StreamList.tsx`: `recordLabel` у записи с `part` и без `docTitle` — `<дата> · часть N из M` (две строки за одну дату иначе читаются как сбой, FR-010); у записи с именем метка уже стоит в имени (`withPartLabel`) — повторно её не выводить; больше ничего не добавляется (конституция, принцип VI). Строка под именем у неразобранной части несёт ту же метку. Добавить случай в `tests/unit/stream-list-read.test.ts`: запись с полями части читается в `StreamSummary` с `part` и `partCount`.
- [ ] T036 [US1] `tests/e2e/interface-truth.e2e.ts` (и фикстуры в `tests/e2e/fixtures.ts`): в списке две части одного эфира и один неделёный эфир; первая часть стоит выше второй, у обеих видна метка «часть N из 2», неделёный эфир метки не имеет. Запуск — `npm run test:e2e`.

**Checkpoint**: `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run build`, `npm run build:pipeline` проходят; отбор возвращает части, конвейер принимает отрезок, разбор считает время абсолютным, список показывает части подряд.

---

## Phase 4: User Story 2 — Отказ одной части не уносит остальные (Priority: P2)

**Goal**: сорвавшаяся часть повторяется сама, не трогая документы и знания остальных; попытки и исчерпание считаются на часть; уборка по префиксам одной части не задевает соседние.

**Independent Test**: сорвать разбор одной части и убедиться, что состояние, векторы и временные объекты другой остались на месте, а повтор и исчерпание касаются только сорвавшейся.

### Tests for User Story 2 ⚠️

- [ ] T037 [P] [US2] `tests/unit/schedule-part-failure.test.ts`: `<vod>-p1` `ready`, `<vod>-p2` `failed` с `attempts: 1` → отбор возвращает вторую часть и только её; `<vod>-p2` с `attempts: MAX_ATTEMPTS` — `retireExhausted` переводит в `skipped` с причиной, а `<vod>-p1` остаётся `ready` без вызова `patchStream`; при исчерпании второй части отбор не возвращает ни её, ни первую (обе закрыты); `attempts` первой части не растёт из-за отказа второй (FR-007, FR-008).
- [ ] T038 [P] [US2] `tests/unit/knowledge-prefix.test.ts` (заглушка сети, без живого сервиса, по образцу `tests/unit/registry-ids.test.ts`): `Knowledge.removeStream("2878430068")` шлёт префикс `2878430068:`, а `removeStream("2878430068-p2")` — `2878430068-p2:`; ни один из них не совпадает с чужим; `removeExcept` и `renameStream` — то же; идентификатор, не подходящий под `STREAM_ID_PATTERN` (пустой, `:`, `2878430068-p2/..`, `2878430068:`), отвергается `AppError("invalid_input")` **до запроса** к сети.
- [ ] T039 [P] [US2] `tests/worker/temporary.test.ts` (среда Worker, настоящая привязка `AUDIO` из `wrangler.jsonc`): в бакет положены `audio/2878430068/chunk-0000.m4a`, `audio/2878430068-p2/chunk-0000.m4a`, `transcript/2878430068/full.txt`, `transcript/2878430068-p2/full.txt`; `removeTemporary(bucket, "2878430068")` удаляет только первые два и не трогает `-p2`; повтор на пустом префиксе безопасен; идентификатор не по образцу отвергается до обращения к бакету.

### Implementation for User Story 2

- [ ] T040 [P] [US2] `src/shared/knowledge.ts`: в `removeStream`, `removeExcept`, `renameStream` — `requireStreamId(streamId)` (`STREAM_ID_PATTERN`, `AppError("invalid_input")`) до запроса: удаление идёт по префиксу `<streamId>:`, и неподходящая строка сносила бы чужое.
- [ ] T041 [P] [US2] Создать `src/worker/temporary.ts`: `TEMPORARY_PREFIXES = ["audio/", "transcript/"] as const` и `removeTemporary(bucket: R2Bucket, streamId: string): Promise<void>` — перебор по префиксу `<префикс><streamId>/` с постраничным удалением (код из `cleanupTemporary` в `src/worker/workflow.ts`); идентификатор проверяется по `STREAM_ID_PATTERN` до обращения к бакету. `workflow.ts` вызывает её вместо собственного метода; `src/worker/index.ts` берёт `TEMPORARY_PREFIXES` отсюда же (сейчас список дублируется).
- [ ] T042 [US2] `src/worker/workflow.ts`: убедиться, что отказ разбора помечает отказавшей только свою запись — `patchStream(params.streamId, …)`, `isAlreadyFinished(params.streamId, …)` — и что в журнале причина отмечена `streamId`; больше кода не менять (изоляция следует из идентификатора). Прогнать T037–T039.

**Checkpoint**: T037–T039 зелёные; отказ и исчерпание попыток по части не затрагивают соседнюю.

---

## Phase 5: User Story 3 — Владелец может перезапустить одну часть (Priority: P3)

**Goal**: повторный разбор, удаление и добавление работают на составных идентификаторах; повторный разбор одной части не трогает остальные.

**Independent Test**: запустить повторный разбор `<vod>-p2` и убедиться, что заново идёт только она; второй запуск во время работы отвергается; удаление `<vod>-p2` не сносит `<vod>-p1`.

### Tests for User Story 3 ⚠️

- [ ] T043 [P] [US3] `tests/contract/streams.test.ts`: повторный разбор `<vod>-p2` запускает бокс с `--stream <vod>-p2 --from … --to …` и не трогает запись `<vod>-p1`; второй запуск того же идентификатора при занятой записи — ошибка `reparse_running`; `<vod>-p5` у эфира из трёх частей — `invalid_input`; удаление `<vod>-p2` уносит векторы `<vod>-p2:`, документ `streams/<vod>-p2.md` и запись реестра, но не `<vod>-p1`; `POST /api/streams` с эфиром в девять часов отвечает 202 с `partCount: 2` и первой частью; при `<vod>-p1` `ready` — с второй; при обеих `ready` — `already_processed`; повторный разбор неделёной `<vod>` у теперь делимого эфира запускает часть 1 и удаляет прежнюю неделёную запись вместе с векторами `<vod>:` и документом `streams/<vod>.md` (Edge Case «повторный разбор неделёного эфира»; неделёная запись `ready` у эфира длиннее шести часов появиться не могла — при кусках по 10 минут даже шесть часов дают 57 обращений из 50, [research.md](./research.md) §2).

### Implementation for User Story 3

- [ ] T044 [US3] `src/worker/routes/streams.ts`: `handleReparseStream(streamId, …)` — запись ищется по `streamId`, `existing` обязана быть (иначе `not_found`), занятость — `reparse_running` (как раньше), запуск — `startStreamIngest(streamId, existing.source, …, REPARSE_ATTEMPTS)`; ответ — `respondToIngest` с `streamId`, `vodId` и частью. `handleDeleteStream(streamId, …)` — занятость и удаление по `streamId` (векторы по префиксу `<streamId>:` проверены T040). `handleAddStream`: `existing` для повторного добавления смотрит на первую не готовую часть (T030), а не на неделёную запись эфира.
- [ ] T045 [US3] `src/ui/components/StreamActions.tsx` и `src/ui/pages/KnowledgePage.tsx`: подтверждение «Разобрать «…» заново?» и «Удалить «…» из базы знаний?» называют часть через `recordLabel`/имя документа с меткой (проверено T035), после повторного разбора одной части строка только этой части переходит в «в обработке»; `tests/unit/stream-actions.test.tsx` — случай для записи с `part`.

**Checkpoint**: T043 зелёный; все три истории работают.

---

## Phase 6: Polish & Cross-Cutting

**Purpose**: документация, сквозные проверки и вынесенная отдельно возможная экономия.

- [ ] T046 [P] `CLAUDE.md`, раздел «Структура»: в перечень `src/shared` добавить `stream-id.ts` (идентификатор записи и части) и `stream-parts.ts` (деление эфира, порог и длина куска), в `src/worker` — `temporary.ts`, в `src/pipeline` — `args.ts`; в абзаце про конвейер оговорить порядок выпуска: сначала `npm run build:pipeline` и укладка `pipeline.mjs` в бокс, потом слияние.
- [ ] T047 [P] `src/ui/pages/ApiPage.tsx`: пути `/api/streams/{streamId}/document` (и reparse, delete) с образцом идентификатора, пример ответа `POST /api/streams` для делёного эфира, в примере найденного знания — поля `stream.streamId` и `stream.vodId`; текст не разрастается — только то, что меняет поведение читателя.
- [ ] T048 [P] `tests/integration/pipeline.test.ts`: привести аргументы запуска к `--stream`, `--from`, `--to` (тест тратит деньги и запускается только по согласию — здесь его **не запускать**, только чтобы он компилировался и не расходился с конвейером).
- [ ] T049 `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run build`, `npm run build:pipeline` — без ошибок и предупреждений; в коде не осталось `vodId` там, где имеется в виду ключ записи (`grep -rn "vodId" src` — каждое вхождение либо номер записи площадки, либо сигнал прежней программы).
- [ ] T050 Возможная экономия двух обращений (FR-017), **замером, а не на веру**: в `wrangler dev` (среда workerd, токен хранилища из `.env`) записать пробный объект `streams/.probe-<случайное>` обычной записью (`multipart: false`, тело — строка в сотни килобайт) и многочастной, оба удалить; результат записать в [research.md](./research.md) §2 (получено 403 `signature_mismatch` либо запись прошла, версия `@upstash/blob`). Если обычная запись **отвергнута** — `multipart: true` остаётся, в spec.md FR-017 дописать «замер повторён, дата, исход» и закрыть задачу. Если **прошла** — убрать `multipart: true` в `Documents.save` (`src/shared/documents.ts`), пересчитать таблицы и «худший случай» в spec.md, research.md §2 и plan.md (39 → 37, 46 → 44) и убрать из комментария над `save` устаревшее объяснение. Задача не блокирует выпуск.
- [ ] T051 В описании Pull Request записать порядок выпуска ([contracts/pipeline.md](./contracts/pipeline.md)): 1) `npm run build:pipeline`; 2) `box files write /workspace/home/pipeline.mjs` (прежняя программа остаётся в боксе под именем `pipeline.prev.mjs` — путь отката); 3) слияние в `main` (это и есть выпуск); 4) приёмочные проверки из [quickstart.md](./quickstart.md). Слияние без пункта 1–2 оставляет Worker, просящий отрезок у программы, которая про отрезки не знает.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: без зависимостей.
- **Foundational (Phase 2)**: после T001; **блокирует все истории**. Внутри: T002–T005, T007, T008, T009, T014, T015 — параллельны друг другу; T010, T011, T012 идут после T006–T009 и параллельны друг другу (разные файлы); T013 — после T012 (берёт `IngestParams`); T016 после T006; T017 — в конце.
- **US1 (Phase 3)**: после T017. Тесты T018–T023 параллельны. T024, T027, T028, T034 — параллельны. T025 после T024 и T004; T026 после T025 и T015; T029 после T004, T018; T030 после T029; T031 после T030; T032 после T027, T028, T031; T033 после T028; T035 после T034; T036 после T035.
- **US2 (Phase 4)**: после T017; независима от US1 в проверяемом: T037 требует T029, T038–T039 — T040–T041. Реализация T040, T041 параллельны.
- **US3 (Phase 5)**: после T030 (нужен `startStreamIngest` с частями); T044 после T030, T045 после T035.
- **Polish (Phase 6)**: после нужных историй; T050 не блокирует выпуск.

### User Story Dependencies

- **US1 (P1)**: после Foundational. MVP.
- **US2 (P2)**: после Foundational; проверка T037 использует отбор из US1.
- **US3 (P3)**: после US1 (`startStreamIngest` с частями).

### Parallel Opportunities

- Фаза 2: T002, T003, T004, T005 вместе; затем T007, T008, T009, T014, T015 вместе.
- US1: T018–T023 вместе (разные файлы); T024, T027, T028, T034 вместе.
- US2: T037, T038, T039 вместе; T040 и T041 вместе.

---

## Parallel Example: User Story 1

```text
# Тесты истории — одновременно, файлы разные:
Task: "tests/unit/schedule-select.test.ts — части в отборе (T018)"
Task: "tests/unit/pipeline-range.test.ts — отрезок и аргументы (T019)"
Task: "tests/unit/document-range.test.ts — проходы и разрывы на отрезке (T020)"
Task: "tests/unit/part-label.test.ts — метка части в имени (T021)"
Task: "tests/contract/internal.test.ts — сигнал с частью (T022)"
Task: "tests/unit/list-order.test.ts — порядок списка (T023)"

# Независимые куски реализации:
Task: "src/pipeline/media.ts — clipChapters (T024)"
Task: "src/shared/categories.ts — проходы и разрывы на отрезке (T027)"
Task: "src/shared/document-name.ts — withPartLabel (T028)"
Task: "src/ui/lib/registry.ts — поля части и порядок списка (T034)"
```

---

## Implementation Strategy

### MVP First (только US1)

1. Фаза 1 и фаза 2 целиком, контрольная точка T017.
2. Фаза 3 (US1) целиком.
3. **Остановиться и проверить**: `npm test`, `npm run test:e2e`, `npm run build:pipeline`.
4. Выпуск по порядку из T051 и приёмочные проверки [quickstart.md](./quickstart.md) 1–3, 6, 7.

### Incremental Delivery

1. Setup + Foundational → основание, поведение прежнее.
2. US1 → длинные эфиры разбираются (MVP, выпуск).
3. US2 → доказанная изоляция отказов и защита префиксной уборки.
4. US3 → повторный разбор, удаление и добавление на составных идентификаторах.
5. Polish → документация; T050 — по замеру.

---

## Notes

- Каждая задача, тронувшая идентификатор, обязана различать номер записи площадки (`vodId`) и идентификатор записи (`streamId`); смешение даёт либо удаление по чужому префиксу, либо ссылку не на ту запись.
- Число обращений на разбор части считается по формуле `N + P + 2×B + 8` ([research.md](./research.md) §2); любая задача, добавляющая внешний вызов в разбор, обязана пересчитать запас.
- Не оставлять заглушек и мёртвого кода: `CHUNK_SECONDS` в `segment.ts`, дубликат `TEMPORARY_PREFIXES` в `index.ts` и `cleanupTemporary` в `workflow.ts` удаляются в тех задачах, что их вытесняют.
- Коммитить после каждой задачи или логической группы; слияние в `main` — это выпуск (`CLAUDE.md`, «Контроль версий»).
