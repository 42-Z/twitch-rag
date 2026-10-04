import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import { APIError } from "openai";
import { AppError, upstreamError } from "../../src/shared/errors.ts";
import { isFramesRejection } from "../../src/shared/openrouter.ts";

/**
 * Какие отказы модели считаются отказом из-за кадров.
 *
 * Форма тела, статусы и коды провайдера — те, что OpenRouter отдавал вживую
 * 2 октября 2026 (`specs/007-stream-frames/research.md` §6): документированных
 * типов `image_download_failed` и `invalid_image` в них нет, везде одно
 * `400 Provider returned error`. Тексты `raw` записаны по фрагментам оттуда
 * («origin returned HTTP 404», «invalid image data … could not be decoded»,
 * «unsupported media type») и на разбор не влияют: решает класс ответа.
 * Ошибки строятся так, как их строит адаптер: ошибка SDK внутри `AppError`
 * через `upstreamError`. Голый объект со статусом не показал бы, доходит ли
 * статус до классификации.
 */
function fromSdk(status: number, metadata?: Record<string, unknown>): AppError {
  const sdk = APIError.generate(
    status,
    { message: "Provider returned error", code: status, ...(metadata === undefined ? {} : { metadata }) },
    `${status} Provider returned error`,
    new Headers(),
  );
  return upstreamError("составление документа", sdk);
}

describe("отказ по кадрам", () => {
  beforeEach(() => {
    // `upstreamError` пишет причину в журнал; в выводе проверок ей делать нечего.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each([
    [
      "объект удалён или ключа не было",
      { raw: "origin returned HTTP 404", provider_name: "Meta", provider_error_code: "media_url_origin_error" },
    ],
    [
      "подпись испорчена",
      { raw: "origin returned HTTP 403", provider_name: "Meta", provider_error_code: "media_url_origin_error" },
    ],
    [
      "адрес не отвечает",
      { raw: "media url not fetchable", provider_name: "Meta", provider_error_code: "media_url_not_fetchable" },
    ],
    // Без кода провайдера: класс ответа — единственное, что выдаёт кадр.
    ["заголовок JPEG, внутри мусор", { raw: "invalid image data: could not be decoded", provider_name: "Meta" }],
    ["не картинка", { raw: "unsupported media type", provider_name: "Meta" }],
  ])("400: %s — откат без кадров", (_case, metadata) => {
    expect(isFramesRejection(fromSdk(400, metadata))).toBe(true);
  });

  test("403 — тоже отказ по кадрам", () => {
    // Отказ по модерации вживую не вызывался; класс ответа тот же, что у остальных.
    expect(isFramesRejection(fromSdk(403))).toBe(true);
  });

  test("404, 413 и 422 — отказы по кадрам: запрос с картинкой не принят", () => {
    for (const status of [404, 413, 422]) expect(isFramesRejection(fromSdk(status))).toBe(true);
  });

  test("отказ модели по содержанию", () => {
    expect(isFramesRejection(new AppError("model_refused", "Модель отказалась отвечать."))).toBe(true);
  });

  test("ошибка SDK без обёртки читается так же", () => {
    const bare = APIError.generate(400, { message: "Provider returned error", code: 400 }, "400 Provider returned error", new Headers());

    expect(isFramesRejection(bare)).toBe(true);
  });
});

describe("не отказ по кадрам", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each([
    [401, "ключ"],
    [402, "деньги"],
    [408, "срок ответа"],
    [429, "частота запросов"],
  ])("%i — %s: повтор без кадров не поможет", (status) => {
    expect(isFramesRejection(fromSdk(status))).toBe(false);
  });

  test.each([500, 502, 503])("%i — сбой сервера", (status) => {
    expect(isFramesRejection(fromSdk(status))).toBe(false);
  });

  test("обрыв соединения: статуса нет", () => {
    expect(isFramesRejection(upstreamError("составление документа", new Error("fetch failed")))).toBe(false);
  });

  test("ошибка без статуса и не ошибка вовсе", () => {
    expect(isFramesRejection(new Error("что-то сломалось"))).toBe(false);
    expect(isFramesRejection("строка")).toBe(false);
    expect(isFramesRejection(undefined)).toBe(false);
    expect(isFramesRejection(null)).toBe(false);
  });

  test("обрыв по потолку — не про кадры", () => {
    expect(isFramesRejection(new AppError("output_truncated", "обрыв"))).toBe(false);
  });

  test("сервис недоступен без причины — не про кадры", () => {
    expect(isFramesRejection(new AppError("upstream_unavailable", "недоступен"))).toBe(false);
  });

  test("свой статус AppError ответа модели не говорит", () => {
    // `invalid_input` у AppError — 400, но это наша ошибка, а не ответ провайдера:
    // по ней кадры бы откатывались на любой ошибке проверки входа.
    const own = new AppError("invalid_input", "неверный вход");

    expect(own.status).toBe(400);
    expect(isFramesRejection(own)).toBe(false);
  });
});
