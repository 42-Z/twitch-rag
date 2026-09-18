## Взаимодействие

Общайся только на русском

По существу отвечай на вопрос, ни больше ни меньше

## Перепроверка

Всегда проверяй методы, ограничения, по официальной документации

Нелья сказать "Библиотека X не позволяет сделать Y", нужно доказать

## Документация

- OpenAI: https://developers.openai.com/llms.txt
- Cloudflare: https://developers.cloudflare.com/llms.txt
- Twitch: https://dev.twitch.tv/docs
- Upstash: https://upstash.com/llms.txt
- Bun: https://bun.com/llms.txt
- Openrouter: https://openrouter.ai/llms.txt

## Описание проекта

База знаний для нейросетей, строящаяся за счет трнсляций с Twitch

Алгоритм:
- Каждый новый стрим транскрибируется
- Расшифровка подается нейросети и она превращает его в структурированный документ
- Расшифровка и запись не сохраняется
- Данные переходят в векторную базу данных
- Теперь по запросу могут выдаваться релевантные данные с помощью векторного поиска

## Запуск

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Структура

Три среды исполнения: Worker на Cloudflare, конвейер в песочнице Upstash Box и
страница в браузере. Код разделён по ним, общее лежит в `src/shared`.

```
src/shared/      общее для всех сред
  twitch.ts        площадка: архив, живые эфиры, длительности
  openrouter.ts    обращения к моделям: распознавание, документ, имя, эмбеддинги
  prompt.ts        инструкция, по которой составляется документ
  document-schema.ts  строгая схема ответа модели
  document-parts.ts   проходы составления и деление участка при обрыве
  document-name.ts    имя документа и его отсутствие
  documents.ts     документы в объектном хранилище: запись, чтение, шапка
  chunks.ts        нарезка разделов на куски для векторной базы
  knowledge.ts     векторная база: запись кусков, поиск, уборка
  registry.ts      реестр: канал, трансляции, отметки о проверках
  box.ts           запуск конвейера в песочнице
  sections.ts      приведение разделов: порядок, склейка, категории
  categories.ts    главы записи и время разделов
  time.ts          длительности, ссылки на момент эфира
  errors.ts        коды ошибок и тексты для человека

src/worker/      Cloudflare Worker
  index.ts         разбор адресов, часовой запуск, уборка
  workflow.ts      разбор одной трансляции по шагам
  schedule.ts      почасовой отбор записи к разбору
  naming.ts        имена документам, разобранным до их появления
  mcp.ts           ассистент: поиск по знаниям и перечень трансляций
  env.ts           сборка адаптеров внешних сервисов
  routes/          точки доступа: streams, knowledge, channel, owner, internal, health

src/pipeline/    конвейер в песочнице Box: скачивание и нарезка
  main.ts          вход, разбор аргументов, исход прогона
  media.ts         yt-dlp и ffmpeg, разбор их отказов
  segment.ts       нарезка записи на куски
  publish.ts       выгрузка кусков и сигнал Worker

src/ui/          страница
  App.tsx          разделы и шапка
  pages/           разделы: знания, управление, главная, API, ассистент
  components/      список трансляций, действия, документ, настройка ассистента
  lib/             чтение реестра из браузера, вызовы владельца, адреса

src/components/ui/, src/lib/, src/hooks/   shadcn/ui и вспомогательное
build.ts         сборка страницы
wrangler.jsonc   Worker: маршруты, хранилища, расписание, Workflows
specs/           спецификации, планы и задачи по SpecKit
.specify/        скиллы и скрипты SpecKit
```

Записи с Twitch скачиваются не сервисом: в Cloudflare нет ни файловой системы,
ни запуска чужих программ. Их скачивает и режет машина, которую сервис заводит
на время у Upstash (в коде — «бокс»), а внутри неё работает собранная программа
конвейера. Эта программа кладётся в машину отдельно, выпуском сервиса не
обновляется и без этого в бою не меняется:

```
bun build src/pipeline/main.ts --target=node --outfile=pipeline.mjs
box files write /workspace/home/pipeline.mjs
```

## Контроль версий

Всегда сам делай коммиты

Измнения делай в отдельной ветке с последующим Pull Request

Основная ветка подключена к Cloudflare: слияние в неё само собирает и выпускает
сервис в боевой. Отдельной команды выпуска нет — «слить» и «выпустить» здесь одно
действие, и относиться к нему надо как к выпуску, а не как к уборке ветки.

Программа, которая скачивает записи, этим не обновляется: она лежит в машине
Upstash и кладётся туда отдельно (см. «Структура»).

## Работа по SpecKit

- Любые действия только в соответствии с GitHub SpecKit
- Читай скиллы SpecKit сам и понимай, как они подходят к процессу
- Не пиши план, пока не обсудил все со страшим разработчиком
- Проверки, для которых нужен развёрнутый сервис, в список задач не пишутся.
  Список задач — для шага разработки, и в нём не должно быть пунктов, которые
  на этом шаге выполнить нельзя: иначе «закрыт» перестаёт значить «готово к
  выпуску». Такие проверки выносятся отдельно и называются приёмочными — они
  про то, что выпущенное работает, и делаются после выпуска
