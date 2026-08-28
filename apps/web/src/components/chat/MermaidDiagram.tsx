import { useEffect, useState } from "react";
import { mermaidClipboardMarkdown } from "~/lib/mermaidLanguage";
import { renderMermaidSvg } from "~/lib/mermaidRenderer";

function mermaidErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return "Couldn't render diagram.";
}

export function MermaidDiagram({
  code,
  language,
  theme,
  onError,
}: {
  code: string;
  language: string;
  theme: "light" | "dark";
  onError?: (message: string) => void;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clipboardMarkdown = mermaidClipboardMarkdown(code, language);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);

    void renderMermaidSvg(code, theme).then(
      (nextSvg) => {
        if (cancelled) return;
        setSvg(nextSvg);
      },
      (cause: unknown) => {
        if (cancelled) return;
        const message = mermaidErrorMessage(cause);
        setError(message);
        onError?.(message);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [code, onError, theme]);

  if (error !== null) {
    return (
      <p
        className="px-3 pb-2 text-xs text-destructive"
        data-markdown-copy={clipboardMarkdown}
        role="alert"
      >
        {error}
      </p>
    );
  }

  if (svg === null) {
    return (
      <p
        className="px-3 pb-2 text-xs text-muted-foreground"
        aria-busy="true"
        data-markdown-copy={clipboardMarkdown}
      >
        Rendering diagram…
      </p>
    );
  }

  return (
    <div
      className="chat-markdown-mermaid overflow-x-auto px-3 pt-1 pb-3"
      data-markdown-copy={clipboardMarkdown}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
