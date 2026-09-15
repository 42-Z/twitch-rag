/**
 * `GET /api/health` — состояние зависимостей.
 *
 * Смысл проверки в том, чтобы отсутствие ключа или недоступность сервиса были
 * видны до начала работы, а не всплыли на первом же запросе к модели.
 */

import type { Env } from "../env.ts";
import { createServices } from "../env.ts";
import { BoxRunner } from "../../shared/box.ts";

type CheckName = "redis" | "vector" | "blob" | "r2" | "openrouter" | "twitch" | "box";

export async function handleHealth(env: Env): Promise<Response> {
  const services = createServices(env);
  const box = new BoxRunner({ boxId: env.UPSTASH_BOX_ID, apiKey: env.UPSTASH_BOX_API_KEY });

  const checks: Array<[CheckName, Promise<boolean>]> = [
    ["redis", services.registry.healthy()],
    ["vector", services.knowledge.healthy()],
    ["blob", services.documents.healthy()],
    ["r2", r2Healthy(env)],
    ["openrouter", services.models.healthy()],
    ["twitch", services.twitch.healthy()],
    ["box", box.healthy()],
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
