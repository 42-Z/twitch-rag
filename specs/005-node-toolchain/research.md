# Phase 0: что выяснено до плана

**Дата**: 2026-09-19 | **Спецификация**: [spec.md](./spec.md) | **План**: [plan.md](./plan.md)

Изучены: документация Node.js, npm, Vitest (четвёртой и пятой версий), Vite, Tailwind,
esbuild, Rolldown, Cloudflare (проверки, статика, сборки, Wrangler), скиллы проекта.
Спорные места проверены сборкой в отдельной песочнице, а не приняты на слово.

## 1. Почему переезд вообще

**Замер.** Проверочный набор Cloudflare под прежней средой поднимает Worker и отвечает
на прямые запросы, но исходящие запросы Worker'а не работают: ни перехватить их, ни
доставить до своего сервера — ноль дошло. Под Node тот же набор отвечает.

**Документация.** Перехват исходящих в наборе описан так: «The test harness proxies
outbound `fetch()` requests from your Workers through the `globalThis.fetch()` function in
your **Node** environment» ([подготовка состояния](https://developers.cloudflare.com/workers/testing/test-harness/prepare-test-state/)).
Среда запуска Wrangler тоже описана однозначно: «We support running the Wrangler CLI with
the Current, Active, and Maintenance versions of **Node.js**» ([установка](https://developers.cloudflare.com/workers/wrangler/install-and-update/)).

## 2. Среда: что даёт Node и чего не даёт

- **TypeScript исполняется без сборки**: «By default Node.js will execute TypeScript files
  that contains only erasable TypeScript syntax», устойчиво с 24.12
  ([Modules: TypeScript](https://nodejs.org/docs/latest/api/typescript.md)).
- **Но `tsconfig.json` Node игнорирует целиком**: «features that depend on settings within
  `tsconfig.json`, such as paths or converting newer JavaScript syntax to older standards,
  are intentionally unsupported». Значит, псевдоним `@/…` (13 файлов страницы) и `.tsx` для
  него не существуют; `.tsx` прямо помечен «unsupported». Устойчивость держится на
  `erasableSyntaxOnly` и на том, что в проекте нет `enum`, `namespace` с кодом и декораторов
  (проверено поиском).
- **Автозагрузки `.env` нет**: только `--env-file`, и «An error is thrown if the file does
  not exist» — есть парный `--env-file-if-exists`. Отдельно: «Environment variables loaded
  from a file with `--env-file` are not applied to the command executed by `--run`» — то есть
  запускать скрипты надо через `npm run`, а флаг держать внутри команд
  ([CLI](https://nodejs.org/docs/latest/api/cli.md)).
- **Замки**: npm знает только `package-lock.json` и `yarn.lock`; про `bun.lock` в его
  документации нет ничего — задокументированного переноса не существует.
- **Верхнеуровневый `await`**: у esbuild вложение такого кода возможно только при выводе в
  формате модулей ([esbuild](https://esbuild.github.io/content-types/#javascript)).

## 3. Проверки: Vitest и встроенная проверка Cloudflare

- **Версия**: плагин Cloudflare требует `vitest@^4.1.0`; в реестре `latest` — пятая, и
  совместимость с ней не заявлена ни в документации, ни в зависимостях пакета. Берём 4.1.x
  и читаем документацию четвёртой версии.
- **Разделение наборов**: штатное `test.projects` (прежнее `workspace` объявлено
  устаревшим). Плагин подключается только у набора Worker'а: хуки плагинов корневого
  настройки выполняются всегда, и в корне он распространился бы на весь прогон
  ([projects](https://v4.vitest.dev/guide/projects)). Примера такого разделения в
  документации Cloudflare нет — рабочий образец есть в их же репозитории.
- **Что даёт встроенная проверка**: `env` и `exports` из `cloudflare:workers`, помощники из
  `cloudflare:test`, изоляция хранилищ на файл проверок, запуск целиком локально
  ([встроенная проверка](https://developers.cloudflare.com/workers/testing/vitest-integration/)).
- **Ограничения, которые надо знать заранее** ([known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)):
  покрытие только инструментированием (встроенное V8 не поддерживается); поддельные таймеры
  не действуют на хранилища; динамический `import()` не работает внутри обработчиков;
  изоляция хранилищ — на файл; плагин **сам включает** `nodejs_compat`, из-за чего проверки
  могут проходить там, где выпуск потом падает (у нас флаг уже включён в настройке).
- **Переход с прежнего запускающего**: руководства по переходу с него не существует, но и
  переносить нечего — наши проверки используют пять имён (`test`, `expect`, `describe`,
  `afterEach`, `afterAll`) и ни одного мока.

## 4. Страница: Vite

- **Версия**: документация Vite — восьмая; сборка идёт через Rolldown, имена настроек
  отличаются от прежних версий (`build.rollupOptions` заменено, точка входа вынесена на
  верхний уровень). Копировать чужие конфиги нельзя.
- **Ловушка с путём входа** (проверено сборкой): если точка входа лежит не в корне сборки,
  страница уезжает в `dist/<путь от корня>/index.html`. Для Cloudflare это молчаливая
  поломка: раздача статики на неизвестный адрес отдаёт `/index.html`, а его там нет
  ([статика](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)).
  Лечится объявлением корнем папки страницы; тогда и результат, и файл настроек, и `.env`
  считаются от неё.
- **Ловушка с значениями** (проверено сборкой): `process.env.ЧТО_УГОДНО` в браузерном коде
  превращается в пустую ссылку без единой ошибки. Документированный способ —
  `import.meta.env` с приставкой `VITE_` ([переменные](https://vite.dev/guide/env-and-mode)).
  Проверка «не задано — падать» из прежней сборки сохраняется: она ловит именно эту поломку.
- **Tailwind**: официальный путь — плагин для Vite; прежний плагин в документации Tailwind
  не упоминается вовсе, то есть переезд здесь не потеря, а выход на поддерживаемый путь
  ([Tailwind с Vite](https://tailwindcss.com/docs/installation/using-vite)).

## 5. Worker и выпуск

- **Сборка Worker'а остаётся на Wrangler.** Документация прямо разводит две ветки: «Wrangler
  bundling is not applicable if you're using the Cloudflare Vite plugin»
  ([сборка](https://developers.cloudflare.com/workers/wrangler/configuration/)).
- **Плагин Cloudflare для Vite** — вторая ветка: «A full-featured integration between Vite
  and the Workers runtime», собирает статику, гоняет Worker в workerd при разработке
  ([плагин](https://developers.cloudflare.com/workers/vite-plugin/)). Отвергнут: он потребовал
  бы перевести на него весь Worker вместе с расписанием, Workflows и ограничителем частоты,
  поддержка которых в нём не проверена, ради удобства, которого у нас нет в требованиях.
- **Выпуск**: сборочная среда Cloudflare выполняет команду сборки и команду развёртывания,
  пакетный менеджер — на выбор; Wrangler берётся из `package.json`. Сборочные переменные
  задаются отдельно от значений времени исполнения и в рантайм не попадают
  ([сборки](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)) — отсюда
  требование переименовать их вместе с кодом.

## 6. Программа конвейера

- **esbuild**: `--bundle --platform=node --format=esm` даёт один самодостаточный файл;
  встроенные модули Node исключаются автоматически, обычные зависимости вкладываются внутрь,
  верхнеуровневый `await` собирается при формате модулей ([esbuild](https://esbuild.github.io/api/)).
- **Отвергнуто: сборка Vite для серверного кода** — зависимости остаются внешними, а в
  машине у Upstash папки зависимостей нет.
- **Отвергнуто: Rolldown** — современнее и приезжает вместе с Vite, но документация Vite не
  описывает сборку консольных программ, отсылая для этого к Rolldown напрямую; лишний
  инструмент ради одной команды.

## 7. Что осталось непроверенным

- **Поддержка наших привязок встроенной проверкой Cloudflare**: расписание, Workflows,
  ограничитель частоты, R2. Документация о них молчит применительно к проверкам. Проверяется
  пробой до того, как на ней будут написаны проверки: если чего-то не хватает, набор
  Worker'а остаётся на проверочном наборе Wrangler, а цель работы достигается частично.
- **Сборка страницы целиком** — прежняя точка входа с HTML-импортами у Vite заменяется
  `index.html` как точкой входа; проверяется сборкой и браузерными проверками.
- **Время прогона** после разделения наборов: подъём среды Worker'а не должен превратить
  обычный прогон в ожидание. Измеряется на шаге проверок.
