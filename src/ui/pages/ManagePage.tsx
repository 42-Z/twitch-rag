/**
 * Раздел управления: отслеживаемый канал, сведения о стримере и добавление
 * записей вручную.
 *
 * Пока токен не предъявлен и не проверен, видно только поле токена и
 * пояснение — остальные поля ввода скрыты (FR-037).
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { addStreamOutcome, callOwnerApi, TOKEN_HINT, type TokenState } from "../lib/owner.ts";
import type { ChannelSummary } from "../lib/registry.ts";

/**
 * Пример заполнения: показывает, чего от поля ждут, лучше любого пояснения.
 * Взят из настоящего описания канала, а не выдуман.
 */
const STREAMER_INFO_EXAMPLE =
  "5opka — Кирилл Баранов, стримит истории из жизни и разборки с чатом, играет в Minecraft. Постоянные собеседники: Соня (sonasheka), Мафаня (mafanyaking), Buster, MellSher. Главный мем канала — «42, братуха».";

/** Пример для поля ассистента: общее описание, а не список исправлений. */
const AGENT_INFO_EXAMPLE =
  "5opka (пятёрка) — Кирилл Баранов, стример из Ростова-на-Дону. Канал про общение: истории из жизни, разборки с чатом, просмотр фильмов и видео, Minecraft, музыка. Постоянные собеседники: Соня, Мафаня, Buster, MellSher.";

type ManageAction = "channel" | "stream" | "streamer" | "agent";

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
  const [streamerInfo, setStreamerInfo] = useState("");
  const [agentInfo, setAgentInfo] = useState("");
  /**
   * Пока владелец не сохранил набранное, перечитывание канала не затирает
   * поле: обновление соседнего действия или сбой чтения не должны отнимать
   * несохранённый текст.
   */
  const [streamerDirty, setStreamerDirty] = useState(false);
  const [agentDirty, setAgentDirty] = useState(false);
  const [busy, setBusy] = useState<ManageAction | undefined>(undefined);
  /** Итог действия помнит, какая форма его вызвала: подпись показывается там же, где нажимали. */
  const [message, setMessage] = useState<
    { what: ManageAction; kind: "success" | "note" | "error"; text: string } | undefined
  >(undefined);

  const allowed = tokenState === "valid";

  // Поле показывает то, что лежит в реестре: страница читает канал сама, и
  // после сохранения или перезагрузки значение приходит оттуда, а не из
  // памяти формы.
  const savedStreamerInfo = channel?.streamerInfo ?? "";
  useEffect(() => {
    if (streamerDirty) return;
    setStreamerInfo(savedStreamerInfo);
  }, [savedStreamerInfo, streamerDirty]);

  // Второе поле живёт в той же записи канала, но меняется своим действием.
  const savedAgentInfo = channel?.agentStreamerInfo ?? "";
  useEffect(() => {
    if (agentDirty) return;
    setAgentInfo(savedAgentInfo);
  }, [savedAgentInfo, agentDirty]);

  /**
   * Подпись об исходе: у действия он свой.
   *
   * `note` — не успех и не ошибка. Так помечается исход, при котором владелец
   * сделал всё правильно, а сервис всё равно ничего не сделал: запись, которую
   * разбирать нечего. Зелёный цвет утверждал бы, что запись принята.
   */
  async function submit(
    what: ManageAction,
    action: () => Promise<{ kind: "success" | "note"; text: string }>,
    reset: () => void,
  ): Promise<void> {
    setBusy(what);
    setMessage(undefined);
    try {
      const outcome = await action();
      setMessage({ what, kind: outcome.kind, text: outcome.text });
      reset();
      onChanged();
    } catch (error) {
      setMessage({ what, kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(undefined);
    }
  }

  /** Подпись об исходе действия — рядом с кнопкой, а не в шапке страницы. */
  function outcome(what: ManageAction): React.JSX.Element | null {
    if (message === undefined || message.what !== what) return null;
    const color =
      message.kind === "error"
        ? "text-destructive"
        : message.kind === "note"
          ? "text-muted-foreground"
          : "text-emerald-600";
    return <p className={`text-sm ${color}`}>{message.text}</p>;
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          Токен владельца
          {allowed && <Badge variant="secondary">принят</Badge>}
        </h2>
        <p className="text-sm text-muted-foreground">
          После перезагрузки страницы токен нужно ввести заново.
        </p>
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
      </section>

      {allowed && (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Отслеживаемый канал</h2>
            <p className="text-sm text-muted-foreground">
              {channel === undefined
                ? "Канал ещё не указан — сервис ничего не отслеживает."
                : `Сейчас отслеживается «${channel.displayName}». В работу берутся только эфиры после момента подключения.`}
            </p>
            <form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submit(
                  "channel",
                  async () => {
                    await callOwnerApi("/api/channel", "PUT", adminToken, { login: channelLogin });
                    return { kind: "success", text: `Канал «${channelLogin}» подключён.` };
                  },
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
            {outcome("channel")}
          </section>

          {/* Сведения относятся к отслеживаемому каналу и живут в его записи:
              без канала их негде хранить, и заполненное поле пропало бы при
              перезагрузке. Отслеживаемый канал выше объясняет своё состояние. */}
          {channel !== undefined && (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Сведения о стримере для разбора</h2>
              <p className="text-sm text-muted-foreground">
                Эти сведения уходят в инструкцию, по которой составляется документ. Из них разбор узнаёт,
                как на самом деле зовут участников и что означают словечки канала, — без них имена
                распознаются как случайный набор звуков.
              </p>
              <p className="text-sm text-muted-foreground">
                Пишите коротко: кто это, о чём канал, кто постоянные собеседники, какие на канале свои
                словечки. Пустое поле — сведений нет, разбор идёт как обычно.
              </p>
              <p className="text-sm text-muted-foreground">
                Ассистент, подключённый по MCP, эти сведения не получает: для него есть отдельное поле ниже.
              </p>
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit(
                    "streamer",
                    async () => {
                      await callOwnerApi("/api/streamer", "PUT", adminToken, { info: streamerInfo });
                      return { kind: "success", text: "Сведения сохранены." };
                    },
                    () => setStreamerDirty(false),
                  );
                }}
              >
                <Label htmlFor="streamer-info">Сведения о стримере для разбора</Label>
                <Textarea
                  id="streamer-info"
                  value={streamerInfo}
                  onChange={(event) => {
                    setStreamerInfo(event.target.value);
                    setStreamerDirty(true);
                  }}
                  placeholder={STREAMER_INFO_EXAMPLE}
                  rows={4}
                />
                <div className="flex items-center justify-between gap-4">
                  {/* Без этой строки владелец ждёт, что уже разобранные
                      документы изменятся сами, и не находит этого. */}
                  <p className="text-sm text-muted-foreground">
                    Действует на следующие разборы. Уже разобранное обновится после «Разобрать заново».
                  </p>
                  <Button
                    type="submit"
                    disabled={busy === "streamer" || streamerInfo === savedStreamerInfo}
                  >
                    {busy === "streamer" ? "Сохраняю…" : "Сохранить"}
                  </Button>
                </div>
              </form>
              {outcome("streamer")}
            </section>
          )}

          {/* Второе поле — для ассистента. Оно публично и на разбор не влияет;
              это сказано прямо, иначе владелец перенесёт сюда сведения для
              разбора или напишет то, чего нельзя показывать. */}
          {channel !== undefined && (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Общая информация о стримере для ассистента</h2>
              <p className="text-sm text-muted-foreground">
                Эти сведения ассистент, подключённый по MCP, получает как ресурс. Их видят все, кто подключается
                к серверу, поэтому не пишите того, что нельзя показывать. На разбор документов они не влияют.
              </p>
              <p className="text-sm text-muted-foreground">
                Пишите коротко: кто это, о чём канал, кто постоянные собеседники. Пустое поле — ресурса нет.
              </p>
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit(
                    "agent",
                    async () => {
                      await callOwnerApi("/api/agent-streamer", "PUT", adminToken, { info: agentInfo });
                      return { kind: "success", text: "Сведения для ассистента сохранены." };
                    },
                    () => setAgentDirty(false),
                  );
                }}
              >
                <Label htmlFor="agent-streamer-info">Общая информация о стримере</Label>
                <Textarea
                  id="agent-streamer-info"
                  value={agentInfo}
                  onChange={(event) => {
                    setAgentInfo(event.target.value);
                    setAgentDirty(true);
                  }}
                  placeholder={AGENT_INFO_EXAMPLE}
                  rows={4}
                />
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm text-muted-foreground">
                    Действует сразу: следующее чтение ресурса отдаст новый текст.
                  </p>
                  <Button type="submit" disabled={busy === "agent" || agentInfo === savedAgentInfo}>
                    {busy === "agent" ? "Сохраняю…" : "Сохранить"}
                  </Button>
                </div>
              </form>
              {outcome("agent")}
            </section>
          )}

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Добавить запись вручную</h2>
            <p className="text-sm text-muted-foreground">
              Новые эфиры сервис находит сам, раз в час. Вручную добавляйте прошлые выпуски.
            </p>
            <form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submit(
                  "stream",
                  async () =>
                    addStreamOutcome(
                      (await callOwnerApi("/api/streams", "POST", adminToken, {
                        url: streamUrl,
                      })) as { status?: string; reason?: string },
                    ),
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
            {outcome("stream")}
          </section>

          <p className="text-sm text-muted-foreground">
            Удаление разобранной трансляции — в разделе «Знания», рядом с ней самой.
          </p>
        </>
      )}
    </div>
  );
}
