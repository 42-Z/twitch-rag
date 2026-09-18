/**
 * Общее для владельческих путей: проверка токена и разбор тела запроса.
 *
 * Вынесено отдельным модулем, потому что этим пользуются все управляющие
 * действия, а не только работа с записями: держать проверку токена в модуле
 * записей значило бы, что добавление настроек канала тянет за собой чужие
 * обязанности.
 */

import { AppError } from "../../shared/errors.ts";
import type { Env } from "../env.ts";

export function requireAdminToken(request: Request, env: Env): void {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token === "" || token !== env.APP_ADMIN_TOKEN) {
    // Неверный токен — отказ в доступе, а не ошибка в запросе: страница
    // владельца различает эти случаи и говорит человеку, что токен не подошёл.
    throw new AppError("unauthorized", "Нужен токен владельца в заголовке Authorization.", {
      hint: "Authorization: Bearer <APP_ADMIN_TOKEN>",
    });
  }
}

export async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError("invalid_input", "Тело запроса должно быть объектом JSON.");
  }
}
