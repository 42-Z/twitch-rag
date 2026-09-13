# Контракт: HTTP API базы знаний

**Дата**: 2026-09-13 | **Спецификация**: [spec.md](../spec.md)

Сервер один (`Bun.serve()`), маршруты объявлены в `routes`. Два класса потребителей:

- **знания** (`/api/knowledge/*`) — программные клиенты, прежде всего ИИ-ассистенты;
- **эксплуатация** (`/api/channel`, `/api/streams/*`, `/api/events`) — операторский интерфейс.

Все тела запросов и ответов — JSON в UTF-8. Время — ISO 8601 UTC. Секунды — целые числа.

## Общий формат ошибки

```json
{
  "error": {
    "code": "vod_unavailable",
    "message": "Запись недоступна: Twitch вернул 404. Возможно, она удалена или доступна только подписчикам.",
    "hint": "Проверьте ссылку или добавьте другую запись."
  }
}
```

`code` — машинный, стабильный; `message` и `hint` — человеческий текст для интерфейса
(FR-030). Коды ошибок: `invalid_input`, `not_found`, `vod_unavailable`, `channel_not_set`,
`already_queued`, `upstream_unavailable`, `quota_exceeded`, `disk_full`, `internal`.

## POST /api/knowledge/search

Главный контракт продукта: по вопросу вернуть знания. Ответ рассчитан на прямую
подстановку в контекст модели (FR-025).

**Запрос**

```json
{
  "query": "что говорили про переход на новый движок",
  "topK": 5,
  "minScore": 0.4,
  "from": "2026-01-01T00:00:00Z",
  "to": "2026-09-01T00:00:00Z",
  "vodIds": ["2345678901"]
}
```

| Поле | Тип | Обязательное | Правила |
|------|-----|--------------|---------|
| `query` | string | да | 1–2000 символов после обрезки пробелов; пустая строка → `invalid_input` |
| `topK` | number | нет | 1–50, по умолчанию 8 |
| `minScore` | number | нет | 0..1, по умолчанию берётся из настроек (0.35) |
| `from` / `to` | string | нет | границы даты эфира |
| `vodIds` | string[] | нет | до 50 идентификаторов |

**Ответ 200**

```json
{
  "query": "что говорили про переход на новый движок",
  "found": true,
  "documents": [
    {
      "id": "2345678901:12",
      "topic": "Причины перехода на новый движок",
      "text": "На стриме 14 марта ведущий объяснил, почему команда уходит со старого движка: ...",
      "score": 0.82,
      "stream": {
        "vodId": "2345678901",
        "title": "Пятничный разбор кода",
        "publishedAt": "2026-03-14T18:03:00Z",
        "url": "https://www.twitch.tv/videos/2345678901?t=1h12m30s"
      },
      "startSeconds": 4350,
      "endSeconds": 4720,
      "language": "ru"
    }
  ],
  "stats": { "returned": 1, "latencyMs": 240 }
}
```

**Ответ 200 при отсутствии знаний** (FR-024) — это не ошибка:

```json
{
  "query": "рецепт борща",
  "found": false,
  "documents": [],
  "message": "В базе знаний нет сведений по этому вопросу.",
  "stats": { "returned": 0, "latencyMs": 180 }
}
```

**Правила**

- `documents` отсортированы по убыванию `score`; ниже `minScore` не попадают.
- `text` приходит целиком — обрезка на середине запрещена.
- Документы одной темы из разных трансляций приходят отдельными элементами (FR-027).
- Запрос обслуживается независимо от того, идёт ли обработка (FR-026).
- Каждый запрос пишется в `query_log`.

## GET /api/knowledge/stats

Состояние базы знаний для клиента: сколько трансляций и документов доступно, за какой
период. Нужен ИИ-клиенту, чтобы честно говорить о границах своих знаний.

```json
{
  "channel": "examplechannel",
  "streams": { "ready": 42, "processing": 1, "failed": 0 },
  "documents": 1834,
  "coverage": { "from": "2026-01-05T17:00:00Z", "to": "2026-09-12T21:30:00Z" },
  "lastIndexedAt": "2026-09-12T23:40:00Z"
}
```

## GET /api/channel · PUT /api/channel

Чтение и установка отслеживаемого канала (FR-001).

**PUT запрос**: `{ "login": "examplechannel" }`

**Ответ**: `{ "twitchUserId": "123456", "login": "examplechannel", "displayName": "ExampleChannel", "watchFrom": "2026-09-13T10:00:00Z", "lastCheckedAt": null }`

Смена канала на другой требует подтверждения флагом `{ "login": "...", "confirmReplace": true }`,
иначе — ошибка `already_queued` с описанием последствий.

## GET /api/streams

Список трансляций для операторского интерфейса (FR-028).

Параметры: `status` (фильтр), `limit` (1–100, по умолчанию 50), `cursor`.

```json
{
  "items": [
    {
      "vodId": "2345678901",
      "title": "Пятничный разбор кода",
      "publishedAt": "2026-03-14T18:03:00Z",
      "durationSeconds": 14400,
      "status": "transcribing",
      "stageProgress": 0.42,
      "documentCount": 0,
      "source": "auto",
      "error": null
    }
  ],
  "nextCursor": null
}
```

## POST /api/streams

Ручное добавление записи по адресу или идентификатору (FR-004).

Запрос: `{ "url": "https://www.twitch.tv/videos/2345678901" }` либо `{ "vodId": "2345678901" }`.

Ответ 202: `{ "vodId": "2345678901", "status": "discovered" }`.
Повторное добавление обработанной записи — ошибка `already_queued` с подсказкой про
перезапуск.

## GET /api/streams/:vodId

Карточка трансляции: состояние, журнал событий и список её документов (US3, сценарий 3).

```json
{
  "vodId": "2345678901",
  "title": "Пятничный разбор кода",
  "publishedAt": "2026-03-14T18:03:00Z",
  "durationSeconds": 14400,
  "language": "ru",
  "status": "ready",
  "documentCount": 37,
  "speechSeconds": 11200,
  "costUsd": 1.42,
  "events": [
    { "at": "2026-03-14T23:10:00Z", "stage": "download", "level": "info", "message": "Аудио получено, 4 части" }
  ],
  "documents": [
    { "id": "2345678901:12", "topic": "Причины перехода на новый движок", "startSeconds": 4350, "endSeconds": 4720 }
  ]
}
```

## POST /api/streams/:vodId/retry

Перезапуск обработки (FR-030, FR-033). Тело: `{ "reason": "manual" }` необязательно.
Обнуляет `attempts`, ставит статус `discovered`, отвечает 202. Для трансляции в состоянии
`ready` это полная переобработка: прежние документы остаются доступными, пока не готовы
новые.

## DELETE /api/streams/:vodId

Удаление трансляции и всех её документов (FR-032). Ответ 200:
`{ "vodId": "2345678901", "deletedDocuments": 37 }`. Повторное удаление — 200 с нулём.

## GET /api/events (WebSocket)

Поток событий обработки для интерфейса оператора, чтобы прогресс был виден без опроса
(FR-029). Сообщения сервера:

```json
{ "type": "stream.progress", "vodId": "2345678901", "status": "transcribing", "stageProgress": 0.42 }
{ "type": "stream.status", "vodId": "2345678901", "status": "ready", "documentCount": 37 }
{ "type": "stream.error", "vodId": "2345678901", "code": "upstream_unavailable", "message": "..." }
{ "type": "queue", "active": 1, "queued": 3 }
```

Клиент ничего не отправляет, кроме `{"type":"ping"}`. Разрыв соединения не влияет на
обработку; при переподключении интерфейс дочитывает состояние через `GET /api/streams`.

## GET /api/health

`{ "status": "ok", "checks": { "sqlite": "ok", "vector": "ok", "blob": "ok", "openai": "ok", "ytDlp": "ok", "ffmpeg": "ok" }, "diskFreeBytes": 48200000000 }`

`status` становится `degraded`, если любая проверка не `ok`. Используется при запуске и в
интерфейсе оператора, чтобы отсутствие ключа или инструмента было видно сразу, а не в
момент падения обработки.

## Доступ

Сервер слушает `127.0.0.1` по умолчанию. Если в настройках указан внешний адрес, включается
обязательный заголовок `Authorization: Bearer <APP_API_TOKEN>` для всех `/api/*`, кроме
`/api/health`. Без токена при внешнем адресе сервер не стартует, а пишет понятную ошибку.
