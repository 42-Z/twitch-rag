import { describe, expect, test } from "vitest";
import { handleSetAgentStreamer } from "../../src/worker/routes/channel.ts";
import { AppError } from "../../src/shared/errors.ts";
import type { Env, Services } from "../../src/worker/env.ts";

/**
 * Контракт общей информации о стримере для ассистента проверяется без сети:
 * запись в реестр — заглушка, форма запроса и защита токеном принадлежат этому
 * слою. Прежнее поле для разбора не должно меняться этим путём.
 */
const ADMIN_TOKEN = "test-admin-token";
const MAX_CHARS = 20_000;

const envWith = (): Env => ({ APP_ADMIN_TOKEN: ADMIN_TOKEN }) as Env;

function servicesWith(): { services: Services; savedAgent: string[]; savedDocument: string[] } {
  const savedAgent: string[] = [];
  const savedDocument: string[] = [];
  const services = {
    registry: {
      setAgentStreamerInfo: async (info: string) => {
        savedAgent.push(info);
      },
      setStreamerInfo: async (info: string) => {
        savedDocument.push(info);
      },
    },
  } as unknown as Services;
  return { services, savedAgent, savedDocument };
}

function request(body: unknown, token = ADMIN_TOKEN): Request {
  return new Request("https://x/api/agent-streamer", {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /api/agent-streamer", () => {
  test("общая информация сохраняется дословно", async () => {
    const { services, savedAgent, savedDocument } = servicesWith();
    const info = "5opka — Кирилл Баранов. Канал про общение: истории из жизни, разборки с чатом, Minecraft, музыка.";

    const response = await handleSetAgentStreamer(request({ info }), envWith(), services);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { saved: boolean };
    expect(body.saved).toBe(true);
    expect(savedAgent).toEqual([info]);
    expect(savedDocument).toEqual([]);
  });

  test("пустая строка — осознанное «не задано», а не отказ", async () => {
    const { services, savedAgent } = servicesWith();

    const response = await handleSetAgentStreamer(request({ info: "" }), envWith(), services);

    expect(response.status).toBe(200);
    expect(savedAgent).toEqual([""]);
  });

  test("текст ровно до предела принимается", async () => {
    const { services, savedAgent } = servicesWith();
    const info = "а".repeat(MAX_CHARS);

    const response = await handleSetAgentStreamer(request({ info }), envWith(), services);

    expect(response.status).toBe(200);
    expect(savedAgent).toEqual([info]);
  });

  test("текст сверх предела отвергается и не сохраняется", async () => {
    const { services, savedAgent } = servicesWith();

    try {
      await handleSetAgentStreamer(request({ info: "а".repeat(MAX_CHARS + 1) }), envWith(), services);
      throw new Error("ожидалась ошибка invalid_input");
    } catch (error) {
      expect((error as AppError).code).toBe("invalid_input");
    }
    expect(savedAgent).toEqual([]);
  });

  test("без токена владельца сведения не сохраняются", async () => {
    const { services, savedAgent } = servicesWith();

    try {
      await handleSetAgentStreamer(request({ info: "что-то" }, "wrong-token"), envWith(), services);
      throw new Error("ожидалась ошибка unauthorized");
    } catch (error) {
      expect((error as AppError).code).toBe("unauthorized");
    }
    expect(savedAgent).toEqual([]);
  });

  test("тело без поля info отвергается", async () => {
    const { services, savedAgent } = servicesWith();

    try {
      await handleSetAgentStreamer(request({ text: "не то поле" }), envWith(), services);
      throw new Error("ожидалась ошибка invalid_input");
    } catch (error) {
      expect((error as AppError).code).toBe("invalid_input");
    }
    expect(savedAgent).toEqual([]);
  });
});
