/**
 * Страница владельца: состояние сервиса, список базы, управление и
 * инструкция подключения ассистента (US3).
 *
 * Асинхронные действия показывают загрузку, успех и ошибку явно (принцип
 * III); разметка не смещается после загрузки данных.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { StreamList } from "./components/StreamList.tsx";
import { DocumentView } from "./components/DocumentView.tsx";
import { McpSetup } from "./components/McpSetup.tsx";
import { getChannel, type ChannelSummary } from "./lib/registry.ts";

interface HealthReport {
  status: "ok" | "degraded";
  checks: Record<string, "ok" | "fail">;
  /** Причина последнего сбоя опроса канала, если он был. */
  lastCheckError?: string | null;
}

/**
 * Полная проверка состояния отвечает только владельцу: каждый её вызов — это
 * десяток обращений к внешним сервисам с крошечными квотами. Без токена
 * приходит признак жизни — «Worker отвечает», и проверок в нём нет.
 */
function useHealth(adminToken: string): HealthReport | undefined {
  const [health, setHealth] = useState<HealthReport | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const headers: Record<string, string> = adminToken === "" ? {} : { Authorization: `Bearer ${adminToken}` };
    fetch("/api/health", { headers })
      .then((response) => response.json())
      .then((data: HealthReport) => {
        if (!cancelled) setHealth(data);
      })
      .catch(() => {
        if (!cancelled) setHealth({ status: "degraded", checks: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [adminToken]);
  return health;
}

async function callOwnerApi(path: string, method: string, token: string, body?: unknown): Promise<unknown> {
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

export function App(): React.JSX.Element {
  const [adminToken, setAdminToken] = useState("");
  const health = useHealth(adminToken);
  const [channel, setChannel] = useState<ChannelSummary | undefined>(undefined);
  const [channelLogin, setChannelLogin] = useState("");
  const [streamUrl, setStreamUrl] = useState("");
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | undefined>(undefined);
  const [busy, setBusy] = useState<"channel" | "stream" | undefined>(undefined);
  const [openDocument, setOpenDocument] = useState<string | undefined>(undefined);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    getChannel().then(setChannel).catch(() => setChannel(undefined));
  }, [refreshToken]);

  async function handleSetChannel(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy("channel");
    setMessage(undefined);
    try {
      await callOwnerApi("/api/channel", "PUT", adminToken, { login: channelLogin });
      setMessage({ kind: "success", text: `Канал «${channelLogin}» подключён.` });
      setChannelLogin("");
      setRefreshToken((n) => n + 1);
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(undefined);
    }
  }

  async function handleAddStream(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy("stream");
    setMessage(undefined);
    try {
      await callOwnerApi("/api/streams", "POST", adminToken, { url: streamUrl });
      setMessage({ kind: "success", text: "Запись принята в обработку." });
      setStreamUrl("");
      setRefreshToken((n) => n + 1);
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(undefined);
    }
  }

  async function handleDeleteStream(vodId: string): Promise<void> {
    await callOwnerApi(`/api/streams/${encodeURIComponent(vodId)}`, "DELETE", adminToken);
  }

  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-8">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold">База знаний канала</h1>
          {health !== undefined && (
            <Badge variant={health.status === "ok" ? "secondary" : "destructive"}>
              {health.status === "ok" ? "работает" : "есть проблемы"}
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {channel === undefined ? "Канал пока не указан" : `Канал: ${channel.displayName}`}
        </p>
      </header>

      {health !== undefined && health.status !== "ok" && (
        <Alert variant="destructive">
          <AlertTitle>Не всё готово к работе</AlertTitle>
          <AlertDescription>
            {Object.entries(health.checks)
              .filter(([, value]) => value !== "ok")
              .map(([name]) => name)
              .join(", ") || "проверьте /api/health"}
          </AlertDescription>
        </Alert>
      )}

      {/* Опрос канала мог ни разу не пройти: тогда новые эфиры не появляются,
          а причина нигде не видна — только здесь. */}
      {health?.lastCheckError != null && (
        <Alert variant="destructive">
          <AlertTitle>Канал не опрашивается</AlertTitle>
          <AlertDescription>{health.lastCheckError}</AlertDescription>
        </Alert>
      )}

      {openDocument !== undefined ? (
        <DocumentView vodId={openDocument} onClose={() => setOpenDocument(undefined)} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Управление</CardTitle>
              <p className="text-sm text-muted-foreground">
                Действия владельца требуют токена — того же, что задан секретом{" "}
                <code>APP_ADMIN_TOKEN</code>.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="admin-token">Токен владельца</Label>
                <Input
                  id="admin-token"
                  type="password"
                  value={adminToken}
                  onChange={(event) => setAdminToken(event.target.value)}
                  autoComplete="off"
                />
              </div>

              {message !== undefined && (
                <p className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-emerald-600"}>
                  {message.text}
                </p>
              )}

              <form className="flex items-end gap-2" onSubmit={handleSetChannel}>
                <div className="flex-1 space-y-1">
                  <Label htmlFor="channel-login">Логин канала на Twitch</Label>
                  <Input
                    id="channel-login"
                    value={channelLogin}
                    onChange={(event) => setChannelLogin(event.target.value)}
                    placeholder="examplechannel"
                    required
                  />
                </div>
                <Button type="submit" disabled={busy === "channel" || channelLogin === ""}>
                  {busy === "channel" ? "Подключаю…" : "Указать канал"}
                </Button>
              </form>

              <form className="flex items-end gap-2" onSubmit={handleAddStream}>
                <div className="flex-1 space-y-1">
                  <Label htmlFor="stream-url">Адрес записи</Label>
                  <Input
                    id="stream-url"
                    value={streamUrl}
                    onChange={(event) => setStreamUrl(event.target.value)}
                    placeholder="https://www.twitch.tv/videos/2345678901"
                    required
                  />
                </div>
                <Button type="submit" variant="secondary" disabled={busy === "stream" || streamUrl === ""}>
                  {busy === "stream" ? "Добавляю…" : "Добавить вручную"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Separator />

          <section>
            <h2 className="mb-3 text-lg font-medium">Что знает база</h2>
            <StreamList onOpen={setOpenDocument} onDelete={handleDeleteStream} refreshToken={refreshToken} />
          </section>

          <Separator />

          <McpSetup />
        </>
      )}
    </main>
  );
}
