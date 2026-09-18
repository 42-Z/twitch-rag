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

## Контроль версий

Всегда сам делай коммиты

Измнения делай в отдельной ветке с последующим Pull Request

## Работа по SpecKit

- Любые действия только в соответствии с GitHub SpecKit
- Читай скиллы SpecKit сам и понимай, как они подходят к процессу
- Не пиши план, пока не обсудил все со страшим разработчиком
