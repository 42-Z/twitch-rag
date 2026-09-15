/**
 * Документ трансляции целиком (FR-031). Читается через Worker — бакет
 * приватный, страница не имеет к нему прямого доступа.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";

interface DocumentViewProps {
  vodId: string;
  onClose: () => void;
}

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; text: string };

export function DocumentView({ vodId, onClose }: DocumentViewProps): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    fetch(`/api/streams/${encodeURIComponent(vodId)}/document`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Документ не открылся (код ${response.status}).`);
        return await response.text();
      })
      .then((text) => {
        if (!cancelled) setState({ kind: "ready", text });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [vodId]);

  return (
    <div className="space-y-4">
      <Button size="sm" variant="ghost" onClick={onClose}>
        ← К списку
      </Button>

      {state.kind === "loading" && (
        <div className="space-y-2" aria-busy="true" aria-label="Загрузка документа">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      )}

      {state.kind === "error" && (
        <Alert variant="destructive">
          <AlertTitle>Не удалось открыть документ</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {state.kind === "ready" && (
        <article className="prose prose-sm max-w-none whitespace-pre-wrap">{state.text}</article>
      )}
    </div>
  );
}
