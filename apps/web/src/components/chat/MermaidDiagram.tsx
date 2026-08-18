import { useEffect, useState } from "react";

import {
  mermaidSourceAsMarkdownFence,
  renderMermaidSvg,
  type MermaidColorScheme,
} from "~/lib/mermaidRendering";

const STREAMING_RENDER_DEBOUNCE_MS = 120;

interface MermaidDiagramProps {
  readonly code: string;
  readonly theme: MermaidColorScheme;
  readonly isStreaming: boolean;
}

type MermaidDiagramState =
  | { readonly status: "idle" }
  | { readonly status: "ready"; readonly svg: string }
  | { readonly status: "error"; readonly message: string };

export function MermaidDiagram({ code, theme, isStreaming }: MermaidDiagramProps) {
  const [state, setState] = useState<MermaidDiagramState>({ status: "idle" });

  useEffect(() => {
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      setState({ status: "idle" });
      return;
    }

    let cancelled = false;
    const run = () => {
      void renderMermaidSvg(trimmed, theme).then(
        (svg) => {
          if (!cancelled) setState({ status: "ready", svg });
        },
        (cause) => {
          if (cancelled) return;
          if (isStreaming) {
            // Incomplete fences fail parse on nearly every token. Keep the last
            // good diagram (or the idle placeholder) until the source settles.
            return;
          }
          const message = cause instanceof Error ? cause.message : "Couldn't render this diagram.";
          setState({ status: "error", message });
        },
      );
    };

    const timeout = isStreaming ? setTimeout(run, STREAMING_RENDER_DEBOUNCE_MS) : undefined;
    if (!isStreaming) run();

    return () => {
      cancelled = true;
      if (timeout != null) clearTimeout(timeout);
    };
  }, [code, isStreaming, theme]);

  const copyMarkdown = mermaidSourceAsMarkdownFence(code);

  if (state.status === "ready") {
    return (
      <div
        className="chat-markdown-mermaid"
        data-markdown-copy={copyMarkdown}
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    );
  }

  if (state.status === "error") {
    return (
      <div className="chat-markdown-mermaid-error" data-markdown-copy={copyMarkdown} role="alert">
        <p>Couldn't render this diagram.</p>
        <p>{state.message}</p>
      </div>
    );
  }

  return (
    <pre className="chat-markdown-mermaid-pending" data-markdown-copy={copyMarkdown}>
      {code.replace(/\n$/, "")}
    </pre>
  );
}
