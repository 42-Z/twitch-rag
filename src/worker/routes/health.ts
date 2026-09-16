/**
 * `GET /api/health` — состояние зависимостей.
 *
 * Смысл проверки в том, чтобы отсутствие ключа или недоступность сервиса были
 * видны до начала работы, а не всплыли на первом же запросе к модели.
 */

import type { Env } from "../env.ts";
import { createServices } from "../env.ts";

type CheckName = "redis" | "vector" | "blob" | "r2" | "openrouter" | "twitch" | "box";

/**
 * Публичный ответ — только признак жизни, без единого обращения наружу.
 *
 * Так сделано не из экономии: у хранилища документов бесплатный тариф — две
 * тысячи операций записи в месяц, у векторной базы — десять тысяч запросов в
 * день, и при исчерпании они просто перестают отвечать до конца окна. Полная
 * проверка на каждый чужой запрос превращала бы сервис в мишень: десяток
 * обращений из одного запроса вычерпывал бы квоту за час, а ограничитель
 * частоты у Cloudflare приблизительный и всплеск пропускает. Поэтому за
 * токеном владельца — полная проверка, а без него — «Worker отвечает».
 */
export function handleHealthLiveness(): Response {
  return Response.json({ status: "ok", checks: {} });
}

export async function handleHealth(env: Env): Promise<Response> {
  const services = createServices(env);

  const checks: Array<[CheckName, Promise<boolean>]> = [
    ["redis", services.registry.healthy()],
    ["vector", services.knowledge.healthy()],
    ["blob", services.documents.healthy()],
    ["r2", r2Healthy(env)],
    ["openrouter", services.models.healthy()],
    ["twitch", services.twitch.healthy()],
    ["box", services.box.healthy()],
  ];

  const results = await Promise.all(checks.map(([, promise]) => promise));
  const report: Record<string, "ok" | "fail"> = {};
  checks.forEach(([name], index) => {
    report[name] = results[index] === true ? "ok" : "fail";
  });

  const channel = await services.registry.getChannel().catch(() => undefined);
  const degraded = results.some((ok) => !ok);

  return Response.json(
    {
      status: degraded ? "degraded" : "ok",
      checks: report,
      channel: channel?.login ?? null,
      lastCheckedAt:
        channel?.lastCheckedAt === undefined
          ? null
          : new Date(channel.lastCheckedAt * 1000).toISOString(),
      // Сбой опроса иначе нигде не виден: расписание пишет его в реестр, а
      // реестр в эту проверку не попадал — владелец узнавал о поломке лишь
      // по тому, что новые эфиры перестали появляться.
      lastCheckError: channel?.lastCheckError === undefined || channel.lastCheckError === "" ? null : channel.lastCheckError,
    },
    { status: degraded ? 503 : 200 },
  );
}

/** Бакет проверяется чтением несуществующего ключа: запись ради проверки не нужна. */
async function r2Healthy(env: Env): Promise<boolean> {
  try {
    await env.AUDIO.head("health/probe");
    return true;
  } catch {
    return false;
  }
}
