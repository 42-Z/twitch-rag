import tailwind from "bun-plugin-tailwind";
import { rm } from "node:fs/promises";
import path from "node:path";

// Сборка интерфейса средствами Bun: отдельный сборщик в стек не добавляется.
// Результат кладётся в dist и раздаётся Cloudflare как статика.
const outdir = path.join(process.cwd(), "dist");

// Значения, без которых страница собирается нерабочей: список трансляций
// читается из реестра прямо из браузера, и без адреса с токеном он не
// откроется. Локально их даёт `.env`, а в сборочной среде они задаются
// переменными сборки; забыть их — значит выложить сломанную страницу молча,
// поэтому сборка без них не проходит.
const REQUIRED_PUBLIC = ["BUN_PUBLIC_REGISTRY_URL", "BUN_PUBLIC_REGISTRY_READONLY_TOKEN"] as const;

const missing = REQUIRED_PUBLIC.filter((name) => (process.env[name] ?? "") === "");
if (missing.length > 0) {
  console.error(
    `Не заданы значения для страницы: ${missing.join(", ")}.\n` +
      "Локально они лежат в `.env`, в сборочной среде — в переменных сборки.",
  );
  process.exit(1);
}

await rm(outdir, { recursive: true, force: true });

// Публичные значения для страницы: адрес реестра и токен только на чтение.
// Ключи, дающие запись, сюда не попадают — они живут в секретах Worker.
const publicEnv: Record<string, string> = {
  "process.env.NODE_ENV": JSON.stringify("production"),
};
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith("BUN_PUBLIC_")) {
    publicEnv[`process.env.${name}`] = JSON.stringify(value ?? "");
  }
}

const result = await Bun.build({
  entrypoints: ["src/ui/index.html"],
  outdir,
  plugins: [tailwind],
  minify: true,
  target: "browser",
  sourcemap: "linked",
  define: publicEnv,
});

if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}

for (const output of result.outputs) {
  const size = (output.size / 1024).toFixed(1);
  console.log(` ${path.relative(process.cwd(), output.path)}  ${size} KB`);
}
