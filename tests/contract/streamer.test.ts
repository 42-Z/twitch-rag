import { test, expect, describe } from "vitest";
import { handleSetStreamer } from "../../src/worker/routes/channel.ts";
import { AppError } from "../../src/shared/errors.ts";
import type { Env, Services } from "../../src/worker/env.ts";

/**
 * Контракт сведений о стримере проверяется без сети: запись в реестр —
 * заглушка, форма запроса и защита токеном принадлежат этому слою.
 */
const ADMIN_TOKEN = "test-admin-token";

const envWith = (): Env => ({ APP_ADMIN_TOKEN: ADMIN_TOKEN }) as Env;

function servicesWith(): { services: Services; saved: string[] } {
  const saved: string[] = [];
  const services = {
    registry: {
      setStreamerInfo: async (info: string) => {
        saved.push(info);
      },
    },
  } as unknown as Services;
  return { services, saved };
}

function request(body: unknown, token = ADMIN_TOKEN): Request {
  return new Request("https://x/api/streamer", {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /api/streamer", () => {
  test("сведения сохраняются дословно", async () => {
    const { services, saved } = servicesWith();
    const info = "5opka — Михаил. Постоянные собеседники: Соня, Влад, Мафаня.";

    const response = await handleSetStreamer(request({ info }), envWith(), services);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { saved: boolean };
    expect(body.saved).toBe(true);
    expect(saved).toEqual([info]);
  });

  test("пустая строка — осознанное «сведений нет», а не отказ", async () => {
    // FR-016: незаполненное поле не мешает разбору. Стереть сведения владелец
    // должен уметь тем же действием, каким их заполнил.
    const { services, saved } = servicesWith();

    const response = await handleSetStreamer(request({ info: "" }), envWith(), services);

    expect(response.status).toBe(200);
    expect(saved).toEqual([""]);
  });

  test("длинный текст принимается: содержимое не проверяется", async () => {
    const { services, saved } = servicesWith();
    const info = "слово ".repeat(500).trim();

    const response = await handleSetStreamer(request({ info }), envWith(), services);

    expect(response.status).toBe(200);
    expect(saved).toEqual([info]);
  });

  test("без токена владельца сведения не сохраняются", async () => {
    const { services, saved } = servicesWith();

    try {
      await handleSetStreamer(request({ info: "что-то" }, "wrong-token"), envWith(), services);
      throw new Error("ожидалась ошибка unauthorized");
    } catch (error) {
      expect((error as AppError).code).toBe("unauthorized");
    }
    expect(saved).toEqual([]);
  });

  test("тело без поля info отвергается", async () => {
    const { services, saved } = servicesWith();

    try {
      await handleSetStreamer(request({ text: "не то поле" }), envWith(), services);
      throw new Error("ожидалась ошибка invalid_input");
    } catch (error) {
      expect((error as AppError).code).toBe("invalid_input");
    }
    expect(saved).toEqual([]);
  });
});
