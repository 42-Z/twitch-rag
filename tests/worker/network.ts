import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";

/**
 * Внешние сервисы Worker'а для проверок в его среде.
 *
 * Привязки платформы (R2, Workflows, ограничитель частоты) — настоящие, из
 * `wrangler.jsonc`: ради этого набор и исполняется внутри среды Worker'а.
 * А сервисы за сетью — реестр Upstash и Twitch — подменяются перехватом
 * исходящих запросов, как описано в документации Cloudflare
 * (https://developers.cloudflare.com/workers/testing/vitest-integration/mock-outbound-requests/).
 * Запрос мимо подмены — ошибка проверки, а не поход в боевой сервис.
 */
export const network = setupNetwork();

export const REGISTRY_URL = "https://registry.test";
export const TWITCH_OAUTH_URL = "https://id.twitch.tv/oauth2/token";
export const TWITCH_HELIX_URL = "https://api.twitch.tv/helix";

type Value = string | Map<string, string> | Map<string, number>;

/**
 * Реестр в памяти, отвечающий по REST-протоколу Upstash Redis.
 *
 * Команды — только те, что Worker шлёт на проверяемых путях. Незнакомая
 * команда валит проверку: подменить её молча значило бы проверять выдумку.
 */
export class FakeRegistry {
  readonly data = new Map<string, Value>();

  handlers() {
    return [
      http.post(`${REGISTRY_URL}/multi-exec`, async ({ request }) => {
        const commands = (await request.json()) as string[][];
        return HttpResponse.json(commands.map((command) => ({ result: encode(this.run(command)) })));
      }),
      http.post(`${REGISTRY_URL}/pipeline`, async ({ request }) => {
        const commands = (await request.json()) as string[][];
        return HttpResponse.json(commands.map((command) => ({ result: encode(this.run(command)) })));
      }),
      http.post(REGISTRY_URL, async ({ request }) => {
        const command = (await request.json()) as string[];
        return HttpResponse.json({ result: encode(this.run(command)) });
      }),
    ];
  }

  hash(key: string): Map<string, string> {
    const value = this.data.get(key);
    return value instanceof Map ? (value as Map<string, string>) : new Map();
  }

  private run([name, ...args]: string[]): unknown {
    switch (name?.toLowerCase()) {
      case "get": {
        const value = this.data.get(args[0] ?? "");
        return typeof value === "string" ? value : null;
      }
      case "set":
        this.data.set(args[0] ?? "", args[1] ?? "");
        return "OK";
      case "del":
        return args.filter((key) => this.data.delete(key)).length;
      case "hgetall":
        return [...this.hash(args[0] ?? "")].flat();
      case "hset": {
        const [key = "", ...pairs] = args;
        const hash = this.hash(key);
        let added = 0;
        for (let i = 0; i < pairs.length; i += 2) {
          if (!hash.has(String(pairs[i]))) added++;
          hash.set(String(pairs[i]), String(pairs[i + 1]));
        }
        this.data.set(key, hash);
        return added;
      }
      case "zadd": {
        const [key = "", ...pairs] = args;
        const set = (this.data.get(key) as Map<string, number> | undefined) ?? new Map<string, number>();
        for (let i = 0; i < pairs.length; i += 2) set.set(String(pairs[i + 1]), Number(pairs[i]));
        this.data.set(key, set);
        return pairs.length / 2;
      }
      default:
        throw new Error(`Подставной реестр не знает команды ${name}`);
    }
  }
}

/**
 * Клиент Upstash просит ответы в base64 и сам их раскодирует — строки
 * отдаются так же, как отдал бы настоящий сервис.
 */
function encode(value: unknown): unknown {
  if (typeof value === "string") {
    return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
  }
  if (Array.isArray(value)) return value.map(encode);
  return value;
}

/** Площадка: выдаёт токен приложения и отвечает о записи заданной длины. */
export function twitchVideo(video: { id: string; duration: string; viewable?: string }) {
  return [
    http.post(TWITCH_OAUTH_URL, () => HttpResponse.json({ access_token: "twitch-token", expires_in: 3600 })),
    http.get(`${TWITCH_HELIX_URL}/videos`, () =>
      HttpResponse.json({
        data: [
          {
            id: video.id,
            title: "Проверочная запись",
            url: `https://www.twitch.tv/videos/${video.id}`,
            created_at: "2026-09-01T18:00:00Z",
            published_at: "2026-09-01T18:00:00Z",
            duration: video.duration,
            viewable: video.viewable ?? "public",
            muted_segments: null,
          },
        ],
      }),
    ),
  ];
}
