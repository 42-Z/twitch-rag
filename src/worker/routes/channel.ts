/**
 * Настройки канала: что отслеживается и что владелец рассказал о стримере.
 *
 * Обе настройки живут в одной записи реестра и меняются владельцем, поэтому
 * и маршруты у них в одном модуле.
 */

import { z } from "zod";
import { AppError } from "../../shared/errors.ts";
import type { Env, Services } from "../env.ts";
import { parseJson, requireAdminToken } from "./owner.ts";

// --- PUT /api/channel: настройка отслеживаемого канала ---

const channelSchema = z.object({ login: z.string().trim().min(1).max(50) });

export async function handleSetChannel(request: Request, env: Env, services: Services): Promise<Response> {
  requireAdminToken(request, env);

  const body = await parseJson(request);
  const parsed = channelSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("invalid_input", "Укажите { login } — логин канала на Twitch.");
  }

  const channel = await services.twitch.getChannelByLogin(parsed.data.login);
  const now = Math.floor(Date.now() / 1000);
  await services.registry.setChannel({
    twitchUserId: channel.id,
    login: channel.login,
    displayName: channel.displayName,
    watchFrom: now,
    addedAt: now,
  });

  return Response.json({ login: channel.login, displayName: channel.displayName, watchFrom: now });
}

// --- PUT /api/streamer: сведения о стримере (FR-014) ---

/**
 * Потолок на длину — не проверка содержимого (FR-015), а защита от тела
 * произвольного размера: сведения уходят в системную инструкцию каждого
 * прохода, и двадцать тысяч знаков там уже заметны, а больше — уже не
 * описание канала.
 */
const MAX_STREAMER_INFO_CHARS = 20000;

const streamerSchema = z.object({ info: z.string().max(MAX_STREAMER_INFO_CHARS) });

/**
 * Сведения о стримере: кто это, о чём канал, кто постоянные собеседники,
 * свои словечки. Что владелец написал, то и уходит в системную инструкцию —
 * содержимое не истолковывается и не проверяется.
 *
 * Пустая строка сохраняется как осознанное «сведений нет»: разбор с ней идёт
 * так же, как если бы поле никогда не заполнялось (FR-016).
 */
export async function handleSetStreamer(request: Request, env: Env, services: Services): Promise<Response> {
  requireAdminToken(request, env);

  const body = await parseJson(request);
  const parsed = streamerSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(
      "invalid_input",
      `Укажите { info } — сведения о стримере одним текстом, не длиннее ${MAX_STREAMER_INFO_CHARS} знаков.`,
    );
  }

  await services.registry.setStreamerInfo(parsed.data.info);
  return Response.json({ saved: true });
}
