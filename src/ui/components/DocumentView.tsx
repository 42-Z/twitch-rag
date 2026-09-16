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

      {state.kind === "ready" && <article className="space-y-3">{renderDocument(state.text)}</article>}
    </div>
  );
}

/**
 * Показ документа. Разметку документ использует свою, известную наперёд —
 * заголовок, строка сведений, заголовки разделов с временем и абзацы, — так
 * что разбирается она здесь же, без библиотеки на такой случай.
 */
function renderDocument(text: string): React.JSX.Element[] {
  const blocks: React.JSX.Element[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push(
      <p key={`p${blocks.length}`} className="text-sm leading-relaxed">
        {renderInline(paragraph.join(" "))}
      </p>,
    );
    paragraph = [];
  };

  for (const line of text.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === "") {
      flush();
      continue;
    }

    const section = /^##\s+(.+?)\s*\[(.+?)\]\s*$/.exec(trimmed);
    if (section) {
      flush();
      blocks.push(
        <h3 key={`h${blocks.length}`} className="pt-4 text-base font-semibold">
          {section[1]}
          <span className="ml-2 text-xs font-normal text-muted-foreground">{section[2]}</span>
        </h3>,
      );
      continue;
    }

    if (trimmed.startsWith("# ")) {
      flush();
      blocks.push(
        <h2 key={`h${blocks.length}`} className="text-lg font-semibold">
          {trimmed.slice(2)}
        </h2>,
      );
      continue;
    }

    paragraph.push(trimmed);
  }

  flush();
  return blocks;
}

/** Жирное начертание — единственная разметка внутри строки, какая у нас бывает. */
function renderInline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={index}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={index}>{part}</span>
    ),
  );
}
