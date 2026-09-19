# Точка отсчёта и итог переезда

**Дата**: 2026-09-19

## До переезда

**Проверки** (`bun test`): 230 проходят, 1 пропущена (сквозной разбор на живом сервисе —
запускается только с `INTEGRATION=1`), 0 падают; 27 файлов, 433 утверждения; прогон ~1,3 с.

**Сборка страницы** (`bun run build`, `build.ts`): в `dist` — `index.html`, один скрипт,
один файл стилей и карта исходников.

**Сборка в Cloudflare** (последняя сборка ветки, прочитано через API сборок):

| Что | Значение |
|-----|----------|
| Команда сборки | `bun run build` |
| Команда развёртывания (ветки) | `npx wrangler versions upload` |
| Значения для страницы | `BUN_PUBLIC_REGISTRY_URL`, `BUN_PUBLIC_REGISTRY_READONLY_TOKEN` |

## После переезда

**Проверки** (`npm test`): 237 проходят, 1 пропущена (та же сквозная), 0 падают.
Прежние 230 сохранены все; 7 новых — Worker в его среде (`tests/worker`).

| Набор | Где исполняется | Проверок | Время |
|-------|-----------------|----------|-------|
| `logic` | Node | 126 + 1 пропущена | ~8 с |
| `workers` | среда Worker'а, привязки из `wrangler.jsonc` | 111 | ~42 с |

**Браузерные проверки** (`npm run test:e2e`): 4 проходят — прежние 3 и сторож стилей.

**Испорченная привязка** (`AUDIO` → `AUDIO_TYPO`): проверка расписания падает с
`Cannot read properties of undefined (reading 'put')`. До переезда таких проверок не было.

**Сборка страницы** (`npm run build`): `dist/index.html`, скрипт, стили, карта исходников.
Без `VITE_REGISTRY_URL` и `VITE_REGISTRY_READONLY_TOKEN` сборка падает с их названиями;
значения из окружения процесса подхватываются без `.env`.

**Программа конвейера** (`npm run build:pipeline`): один файл `pipeline.mjs`, 23 КБ,
внешних импортов только `node:child_process`, `node:fs/promises`, `node:path`. Без папки
зависимостей запускается и отвечает так же, как прежняя сборка.

**Установка с нуля** (`npm ci`): проходит без предупреждений; установочные скрипты
разрешены только `esbuild` и `workerd`.

**Остатки прежней среды** (шаг 1 `quickstart.md`): в `package.json`, настройках
TypeScript, `.gitignore`, `.env.example`, `CLAUDE.md`, `README.md` не найдено; `bun.lock`,
`bunfig.toml`, `build.ts`, `bun-env.d.ts` удалены.

## Что поменять в настройках сборки Cloudflare

Делается владельцем в панели Cloudflare (Workers → twitch-rag → Settings → Build) до
слияния в основную ветку — иначе первая же сборка упадёт:

| Где | Было | Стало |
|-----|------|-------|
| Команда сборки | `bun run build` | `npm run build` |
| Переменная сборки | `BUN_PUBLIC_REGISTRY_URL` | `VITE_REGISTRY_URL` (значение то же) |
| Переменная сборки | `BUN_PUBLIC_REGISTRY_READONLY_TOKEN` | `VITE_REGISTRY_READONLY_TOKEN` (значение то же) |

Команды развёртывания не меняются. Версия Node берётся из `.node-version` (24); npm
сборочная среда выбирает сама по `package-lock.json`.

После выпуска программу конвейера надо пересобрать и переложить в машину:
`npm run build:pipeline`, затем `box files write /workspace/home/pipeline.mjs`.
