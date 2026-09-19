import path from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Сборка страницы. Результат кладётся в dist и раздаётся Cloudflare как статика.
//
// Корень сборки — папка страницы: там лежит `index.html`, и если корень выше,
// страница уезжает в `dist/src/ui/index.html`, а раздача статики на неизвестный
// адрес отдаёт `/index.html` — которого нет. Поэтому и `outDir`, и `envDir`
// заданы абсолютными путями: относительные считались бы от корня сборки.
const projectRoot = import.meta.dirname;

// Значения, без которых страница собирается нерабочей: список трансляций
// читается из реестра прямо из браузера, и без адреса с токеном он не
// откроется. Локально их даёт `.env`, а в сборочной среде они задаются
// переменными сборки. Незаданное значение Vite молча подставляет как пустое —
// забыть их значит выложить сломанную страницу, поэтому сборка без них не
// проходит.
const REQUIRED_PUBLIC = ["VITE_REGISTRY_URL", "VITE_REGISTRY_READONLY_TOKEN"] as const;

function requirePublicEnv(): Plugin {
  return {
    name: "require-public-env",
    apply: "build",
    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir || projectRoot);
      const missing = REQUIRED_PUBLIC.filter((name) => (env[name] ?? "") === "");
      if (missing.length > 0) {
        throw new Error(
          `Не заданы значения для страницы: ${missing.join(", ")}.\n` +
            "Локально они лежат в `.env`, в сборочной среде — в переменных сборки.",
        );
      }
    },
  };
}

export default defineConfig({
  root: path.join(projectRoot, "src/ui"),
  envDir: projectRoot,
  plugins: [react(), tailwindcss(), requirePublicEnv()],
  resolve: {
    alias: { "@": path.join(projectRoot, "src") },
  },
  build: {
    outDir: path.join(projectRoot, "dist"),
    emptyOutDir: true,
    sourcemap: true,
  },
});
