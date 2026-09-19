import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import { loadEnv } from "vite";

// Проверки. Наборы разделены по среде исполнения (https://v4.vitest.dev/guide/projects):
// чистая логика и разметка страницы — под Node, без подъёма среды Worker'а.
//
// Плагин Cloudflare подключается только у набора Worker'а и в корень не
// кладётся: хуки плагинов корневой настройки выполняются всегда, и он
// распространился бы на весь прогон.
const projectRoot = import.meta.dirname;

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: { "@": path.join(projectRoot, "src") },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "logic",
          environment: "node",
          include: ["tests/unit/**/*.test.{ts,tsx}", "tests/integration/**/*.test.ts"],
          // Проверки кода Worker'а идут в его среде — набор workers.
          exclude: [
            ...configDefaults.exclude,
            "tests/unit/schedule-select.test.ts",
            "tests/unit/schedule-skip.test.ts",
            "tests/unit/document-naming.test.ts",
          ],
          // Сквозная проверка ходит в настоящие сервисы и берёт ключи из `.env`.
          // Остальным проверкам ключи не даются: промах мимо заглушки не должен
          // уходить в боевое хранилище.
          env: process.env["INTEGRATION"] === "1" ? loadEnv(mode, projectRoot, "") : {},
        },
      },
      // Worker внутри его среды исполнения, с привязками из настройки.
      "./vitest.workers.config.ts",
    ],
  },
}));
