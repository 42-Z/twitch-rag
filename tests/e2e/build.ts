import { execFileSync } from "node:child_process";
import { DEAD } from "./settings.ts";

/**
 * Сборка страницы до проверок.
 *
 * Сервис в проверках отдаёт собранную страницу, и адрес реестра она забирает
 * из сборки: реестр читается прямо из браузера, и промах мимо заглушки в
 * проверке не должен приводить к обращению к боевому хранилищу. Поэтому
 * сборка идёт с подставным адресом, а не с тем, что лежит в `.env`.
 *
 * Значения из окружения сильнее значений из `.env` — на этом здесь всё и
 * держится.
 */
export default function build(): void {
  execFileSync("npm", ["run", "build"], {
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_REGISTRY_URL: DEAD,
      VITE_REGISTRY_READONLY_TOKEN: "stub",
    },
  });
}
