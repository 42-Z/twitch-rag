/**
 * Обращения к владельческим путям и состояние токена.
 *
 * Токен живёт только в памяти страницы: между разделами он сохраняется, а
 * после перезагрузки вводится заново — так он не оседает ни в хранилище
 * браузера, ни в переданной ссылке.
 */

import { useEffect, useState } from "react";

export interface HealthReport {
  status: "ok" | "degraded";
  checks: Record<string, "ok" | "fail">;
  channel?: string | null;
  lastCheckedAt?: string | null;
  /** Причина последнего сбоя опроса канала, если он был. */
  lastCheckError?: string | null;
}

/**
 * Состояние токена. Различать «не вводил» и «не подошёл» нужно потому, что
 * человеку это разные подсказки: в первом случае токен надо взять в секретах
 * сервиса, во втором — проверить, что скопирован целиком.
 */
export type TokenState = "none" | "checking" | "valid" | "invalid" | "unreachable";

export interface OwnerState {
  /** Полный отчёт о состоянии — только с верным токеном. */
  health: HealthReport | undefined;
  tokenState: TokenState;
}

/**
 * Проверка токена идёт через состояние сервиса: с верным токеном приходит
 * полный отчёт, с неверным — отказ `unauthorized`, без токена — один лишь
 * признак жизни. Отдельного запроса «проверь токен» поэтому не нужно.
 */
export function useHealth(adminToken: string): OwnerState {
  const [health, setHealth] = useState<HealthReport | undefined>(undefined);
  const [tokenState, setTokenState] = useState<TokenState>("none");

  useEffect(() => {
    if (adminToken === "") {
      setHealth(undefined);
      setTokenState("none");
      return;
    }

    let cancelled = false;
    setTokenState("checking");

    fetch("/api/health", { headers: { Authorization: `Bearer ${adminToken}` } })
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 401) {
          setHealth(undefined);
          setTokenState("invalid");
          return;
        }
        if (!response.ok) {
          setHealth(undefined);
          setTokenState("unreachable");
          return;
        }
        setHealth((await response.json()) as HealthReport);
        setTokenState("valid");
      })
      .catch(() => {
        if (cancelled) return;
        setHealth(undefined);
        setTokenState("unreachable");
      });

    return () => {
      cancelled = true;
    };
  }, [adminToken]);

  return { health, tokenState };
}

/** Вызов владельческого пути; ошибка сервиса превращается в понятный текст. */
export async function callOwnerApi(
  path: string,
  method: string,
  token: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: { message: string } };
  if (!response.ok) {
    throw new Error(data.error?.message ?? `Запрос завершился с кодом ${response.status}.`);
  }
  return data;
}

/**
 * Что показать владельцу после добавления записи.
 *
 * Сервис отвечает пропуском, когда разбирать запись нечего — она короче трёх
 * минут или доступна не всем зрителям. Обещать разбор в этом случае значит
 * обмануть: владелец пойдёт искать запись в списке разобранных. Пропуск при
 * этом не ошибка — он сделал всё правильно, — поэтому и вид у подписи особый:
 * не зелёный и не красный.
 */
export function addStreamOutcome(answer: { status?: string; reason?: string }): {
  kind: "success" | "note";
  text: string;
} {
  if (answer.status === "skipped") {
    return { kind: "note", text: answer.reason ?? "Запись не будет разобрана." };
  }
  return { kind: "success", text: "Запись принята в обработку." };
}

/** Подпись состояния токена для страницы управления. */
export const TOKEN_HINT: Record<TokenState, string> = {
  none: "Введите токен, чтобы управлять сервисом.",
  checking: "Проверяю токен…",
  valid: "Токен принят.",
  invalid: "Токен не подошёл.",
  unreachable: "Сервис не ответил на проверку. Попробуйте ещё раз.",
};
