import { test, expect, describe } from "bun:test";
import { handleHealthLiveness } from "../../src/worker/routes/health.ts";

/**
 * Публичный ответ проверки состояния обязан быть бесплатным: у хранилища
 * документов бесплатный тариф — две тысячи операций записи в месяц, у
 * векторной базы — десять тысяч запросов в день, и при исчерпании они
 * перестают отвечать до конца окна. Поэтому без токена владельца наружу
 * уходит только признак жизни, и этот тест сторожит, чтобы сюда не вернулись
 * проверки внешних сервисов.
 */
describe("публичный ответ проверки состояния", () => {
  test("отвечает признаком жизни и не трогает внешние сервисы", async () => {
    const response = handleHealthLiveness();
    const body = (await response.json()) as { status: string; checks: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(Object.keys(body.checks)).toHaveLength(0);
  });
});
