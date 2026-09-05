import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { getCachedMermaidSvg, renderMermaidSvg, type MermaidTheme } from "~/lib/mermaid";

type DiagramState =
  | { status: "pending" }
  | { status: "ready"; svg: string }
  | { status: "failed"; message: string };

/**
 * Mermaid parse errors carry a multi-line caret diagram that is useless in a one-line note,
 * so only its first line survives.
 */
function diagramFailureMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const firstLine = message.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return "";
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}

/**
 * A `mermaid` fence rendered as a diagram, the way GitHub renders one. Falls back to the
 * highlighted source when mermaid cannot parse the diagram or its chunk fails to load —
 * a broken diagram should still show what the author wrote.
 */
export function MermaidDiagram({
  code,
  theme,
  source,
}: {
  code: string;
  theme: MermaidTheme;
  /** The fence's highlighted source, shown instead of the diagram when rendering fails. */
  source: ReactNode;
}) {
  const [resolved, setResolved] = useState<{ key: string; state: DiagramState } | null>(null);

  // A cache hit renders the diagram on the first frame — the common case, since scrolling a
  // long pull request body remounts every diagram in it.
  const cached = getCachedMermaidSvg(code, theme);
  const key = `${theme}\n${code}`;
  const state: DiagramState =
    cached != null
      ? { status: "ready", svg: cached }
      : resolved?.key === key
        ? resolved.state
        : { status: "pending" };

  useEffect(() => {
    // Keyed off what the render pass read, not a fresh lookup: a cache write landing between
    // render and here would otherwise skip the render and strand the placeholder, since the
    // cache cannot tell React that it changed.
    if (cached != null) return;

    let cancelled = false;
    void renderMermaidSvg(code, theme).then(
      (svg) => {
        if (!cancelled) setResolved({ key, state: { status: "ready", svg } });
      },
      (cause: unknown) => {
        if (!cancelled) {
          setResolved({ key, state: { status: "failed", message: diagramFailureMessage(cause) } });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cached, code, key, theme]);

  if (state.status === "pending") {
    return <p className="px-3 pt-1 pb-3 text-xs text-muted-foreground">Rendering diagram…</p>;
  }

  if (state.status === "failed") {
    return (
      <>
        <p className="flex items-start gap-1.5 px-3 pt-1 pb-2 text-xs text-muted-foreground">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span>
            Unable to render this diagram.
            {state.message.length > 0 ? ` ${state.message}` : null}
          </span>
        </p>
        {source}
      </>
    );
  }

  return (
    <div
      role="img"
      aria-label="Mermaid diagram"
      className="chat-markdown-mermaid flex justify-center overflow-x-auto px-3 pt-1 pb-3"
      // Mermaid runs its own DOMPurify pass at the `strict` security level this app configures.
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  );
}
