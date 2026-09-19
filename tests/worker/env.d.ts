import type { Env as WorkerEnv } from "../../src/worker/env.ts";

// Окружение, которое `cloudflare:workers` отдаёт проверкам, — то же, что
// получает сам Worker. `wrangler types` здесь не используется: окружение
// описано в коде Worker'а, и держать второе описание значило бы сверять два.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
    // Экспорты главного модуля — для `exports.default.fetch()` в проверках.
    interface GlobalProps {
      mainModule: typeof import("../../src/worker/index.ts");
    }
  }
}
