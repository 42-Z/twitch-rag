/**
 * Действия рядом с записью: открыть документ, разобрать заново, удалить.
 *
 * Отдельным узлом по двум причинам. Они одинаковы во всех разделах списка —
 * разобранное, обработка, пропущенное, — и повторять их трижды значит
 * разойтись им при первой же правке. И они проверяются без браузера: список
 * тянет данные эффектом, который при серверной отрисовке не выполняется, а
 * действия рисуются сразу.
 *
 * Повторный разбор доступен для записи в любом состоянии (FR-028, FR-034).
 * Прежде он был только у разобранных, и запись, которую автоматика больше не
 * возьмёт — пропущенная или неудачная, — вернуть со страницы было нечем:
 * оставалось править хранилище руками.
 */

import { useState } from "react";
import { recordLabel } from "../lib/format.ts";
import type { IngestOutcome } from "../lib/owner.ts";
import { Button } from "@/components/ui/button.tsx";
import type { StreamSummary } from "../lib/registry.ts";

export interface StreamActionsProps {
  stream: StreamSummary;
  onOpen: (vodId: string) => void;
  /** Повторный разбор: возвращает, начат он или запись не взята. */
  onReparse?: (vodId: string) => Promise<IngestOutcome>;
  onDelete?: (vodId: string) => Promise<void>;
  /** Сбой действия: список показывает его рядом с записью, а не вместо себя. */
  onFailed: (vodId: string, text: string) => void;
  /** Запись ушла в работу или исчезла — список приводит себя в соответствие. */
  onDone: (vodId: string, outcome: "reparsed" | "deleted") => void;
  /**
   * Разбора не будет, и вот почему. Отдельно от сбоя: действие прошло, а
   * работы нет — состояние записи менять нечем, а объяснение нужно, иначе
   * владелец решит, что кнопка не сработала, и нажмёт её снова.
   */
  onNote: (vodId: string, text: string) => void;
}

export function StreamActions({
  stream,
  onOpen,
  onReparse,
  onDelete,
  onFailed,
  onDone,
  onNote,
}: StreamActionsProps): React.JSX.Element {
  const [busy, setBusy] = useState<"reparse" | "delete" | undefined>(undefined);
  // Документ есть только у разобранной записи; у остальных открывать нечего.
  const hasDocument = stream.status === "ready";

  function run(
    kind: "reparse" | "delete",
    action: () => Promise<IngestOutcome | undefined>,
    outcome: "reparsed" | "deleted",
  ): void {
    setBusy(kind);
    action()
      .then((result) => {
        // Пропуск — не «запись ушла в работу»: показывать её разбираемой
        // значило бы обещать работу, которую сервис не начал.
        if (result?.kind === "skipped") {
          onNote(stream.vodId, result.reason);
          return;
        }
        onDone(stream.vodId, outcome);
      })
      .catch((error: unknown) => onFailed(stream.vodId, error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(undefined));
  }

  return (
    <div className="flex shrink-0 gap-2">
      {hasDocument && (
        <Button size="sm" variant="secondary" onClick={() => onOpen(stream.vodId)}>
          Открыть документ
        </Button>
      )}
      {onReparse !== undefined && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== undefined}
          onClick={() => {
            // Предупреждение обязательно: повтор стоит столько же, сколько
            // первый разбор, и владелец должен знать это до нажатия, а не
            // после (FR-035). О замене документа говорится только тогда,
            // когда заменять есть что.
            const confirmed = window.confirm(
              `Разобрать «${recordLabel(stream)}» заново?\n\n` +
                "Запись будет скачана и распознана повторно — это стоит столько же, " +
                "сколько первый разбор." +
                (hasDocument ? " Прежний документ и знания заменятся новыми." : ""),
            );
            if (!confirmed) return;
            void run("reparse", () => onReparse(stream.vodId), "reparsed");
          }}
        >
          {busy === "reparse" ? "Запускаю…" : "Разобрать заново"}
        </Button>
      )}
      {onDelete !== undefined && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== undefined}
          onClick={() => {
            if (!window.confirm(`Удалить «${recordLabel(stream)}» из базы знаний?`)) return;
            // Удаление исхода не возвращает: пропустить его нечего.
            void run(
              "delete",
              async () => {
                await onDelete(stream.vodId);
              },
              "deleted",
            );
          }}
        >
          {busy === "delete" ? "Удаление…" : "Удалить"}
        </Button>
      )}
    </div>
  );
}
