import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";
import { stubBlobToken } from "./tests/e2e/settings.ts";

// Набор Worker'а: проверки исполняются внутри его среды исполнения с привязками
// из `wrangler.jsonc` (https://developers.cloudflare.com/workers/testing/vitest-integration/).
// Плагин подключается только здесь: в корневой настройке его хуки действовали
// бы на весь прогон, включая проверки логики под Node.
//
// Секретов в `wrangler.jsonc` нет — они задаются здесь проверочными значениями,
// а адреса внешних сервисов указывают на подмену сети (`tests/worker/network.ts`).

// Wrangler в локальном запуске подкладывает секреты из `.env` — а там боевые
// значения. Проверкам они не нужны, и промах мимо подмены с ними ушёл бы в
// настоящий сервис. Отключается это переменной процесса, который запускает
// инструменты (https://developers.cloudflare.com/workers/local-development/environment-variables/).
process.env["CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV"] = "false";

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          APP_ADMIN_TOKEN: "worker-test-admin",
          INGEST_SECRET: "worker-test-ingest",
          UPSTASH_REDIS_REST_URL: "https://registry.test",
          UPSTASH_REDIS_REST_TOKEN: "registry-token",
          UPSTASH_VECTOR_REST_URL: "https://vector.test",
          UPSTASH_VECTOR_REST_TOKEN: "vector-token",
          UPSTASH_BLOB_TOKEN: stubBlobToken(),
          UPSTASH_BOX_API_KEY: "box-key",
          UPSTASH_BOX_ID: "box-id",
          OPENROUTER_API_KEY: "openrouter-key",
          TWITCH_CLIENT_ID: "twitch-id",
          TWITCH_CLIENT_SECRET: "twitch-secret",
        },
      },
    }),
  ],
  test: {
    name: "workers",
    // Всё, что вызывает код Worker'а: пути целиком (tests/worker), обработчики
    // с подставными службами (tests/contract) и отбор по расписанию.
    include: [
      "tests/worker/**/*.test.ts",
      "tests/contract/**/*.test.ts",
      "tests/unit/schedule-select.test.ts",
      "tests/unit/schedule-skip.test.ts",
      "tests/unit/document-naming.test.ts",
    ],
    setupFiles: ["tests/worker/setup.ts"],
  },
});
