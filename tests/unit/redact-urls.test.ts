import { test, expect, describe, vi, afterEach } from "vitest";
import { redactUrls, upstreamError } from "../../src/shared/errors.ts";

describe("адреса в тексте ошибки", () => {
  test("подписанная ссылка на кадр заменяется заглушкой, остальной текст остаётся", () => {
    const text = "400 Failed to download https://acct.r2.cloudflarestorage.com/twitch-audio/frames/1/f.jpg?X-Amz-Signature=abc123 (timeout)";

    expect(redactUrls(text)).toBe("400 Failed to download <адрес> (timeout)");
  });

  test("несколько адресов, http тоже", () => {
    expect(redactUrls("http://a.test/x и https://b.test/y?z=1")).toBe("<адрес> и <адрес>");
  });

  test("текст без адресов не меняется", () => {
    expect(redactUrls("Rate limit exceeded")).toBe("Rate limit exceeded");
  });
});

describe("журнал ошибки внешнего сервиса", () => {
  afterEach(() => vi.restoreAllMocks());

  test("причина с подписанной ссылкой пишется в журнал без неё", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    upstreamError("составление документа", new Error("Failed to fetch https://x.r2.cloudflarestorage.com/b/frames/1/f.jpg?X-Amz-Signature=abc123"));

    const line = String(spy.mock.calls[0]?.[0]);
    expect(line).toContain("составление документа");
    expect(line).not.toContain("abc123");
    expect(line).not.toMatch(/https?:\/\//);
  });
});
