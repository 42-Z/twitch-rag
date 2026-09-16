/**
 * Раздел управления: канал и добавление записей.
 *
 * Пока токен не предъявлен и не проверен, видно только поле токена и
 * пояснение — остальные поля ввода скрыты (FR-037).
 */

import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { callOwnerApi, TOKEN_HINT, type TokenState } from "../lib/owner.ts";
import type { ChannelSummary } from "../lib/registry.ts";

interface ManagePageProps {
  adminToken: string;
  onTokenChange: (token: string) => void;
  tokenState: TokenState;
  channel: ChannelSummary | undefined;
  onChanged: () => void;
}

export function ManagePage({
  adminToken,
  onTokenChange,
  tokenState,
  channel,
  onChanged,
}: ManagePageProps): React.JSX.Element {
  const [channelLogin, setChannelLogin] = useState("");
  const [streamUrl, setStreamUrl] = useState("");
  const [busy, setBusy] = useState<"channel" | "stream" | undefined>(undefined);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | undefined>(undefined);

  const allowed = tokenState === "valid";

  async function submit(
    what: "channel" | "stream",
    action: () => Promise<unknown>,
    success: string,
    reset: () => void,
  ): Promise<void> {
    setBusy(what);
    setMessage(undefined);
    try {
      await action();
      setMessage({ kind: "success", text: success });
      reset();
      onChanged();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Токен владельца
            {allowed && <Badge variant="secondary">принят</Badge>}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Тот же токен, что задан секретом <code>APP_ADMIN_TOKEN</code>. Хранится только в
            памяти страницы: после перезагрузки вводится заново, между разделами сохраняется.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="admin-token">Токен</Label>
            <Input
              id="admin-token"
              type="password"
              value={adminToken}
              onChange={(event) => onTokenChange(event.target.value)}
              autoComplete="off"
              placeholder="вставьте токен"
            />
          </div>

          <p
            className={
              tokenState === "invalid" || tokenState === "unreachable"
                ? "text-sm text-destructive"
                : "text-sm text-muted-foreground"
            }
          >
            {TOKEN_HINT[tokenState]}
          </p>

          {message !== undefined && (
            <p className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-emerald-600"}>
              {message.text}
            </p>
          )}
        </CardContent>
      </Card>

      {allowed && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Отслеживаемый канал</CardTitle>
              <p className="text-sm text-muted-foreground">
                {channel === undefined
                  ? "Канал ещё не указан — сервис ничего не отслеживает."
                  : `Сейчас отслеживается «${channel.displayName}». В работу берутся только эфиры после момента подключения.`}
              </p>
            </CardHeader>
            <CardContent>
              <form
                className="flex items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit(
                    "channel",
                    () => callOwnerApi("/api/channel", "PUT", adminToken, { login: channelLogin }),
                    `Канал «${channelLogin}» подключён.`,
                    () => setChannelLogin(""),
                  );
                }}
              >
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Добавить запись вручную</CardTitle>
              <p className="text-sm text-muted-foreground">
                Обычно сервис находит новые эфиры сам раз в час. Вручную стоит добавлять то,
                что появилось до подключения канала, или прошлые выпуски.
              </p>
            </CardHeader>
            <CardContent>
              <form
                className="flex items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit(
                    "stream",
                    () => callOwnerApi("/api/streams", "POST", adminToken, { url: streamUrl }),
                    "Запись принята в обработку.",
                    () => setStreamUrl(""),
                  );
                }}
              >
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
                  {busy === "stream" ? "Добавляю…" : "Добавить"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Alert>
            <AlertTitle>Удаление — в разделе «Знания»</AlertTitle>
            <AlertDescription>
              Разобранную трансляцию можно удалить вместе с документом и разделами прямо из
              списка: кнопка появляется, когда токен принят.
            </AlertDescription>
          </Alert>
        </>
      )}
    </div>
  );
}
