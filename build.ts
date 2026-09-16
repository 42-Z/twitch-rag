import tailwind from "bun-plugin-tailwind";
import { rm } from "node:fs/promises";
import path from "node:path";

// Сборка интерфейса средствами Bun: отдельный сборщик в стек не добавляется.
// Результат кладётся в dist и раздаётся Cloudflare как статика.
const outdir = path.join(process.cwd(), "dist");
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
