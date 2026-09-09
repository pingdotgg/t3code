import { useEffect, useRef, useState } from "react";

import { renderMermaidDiagram } from "../lib/mermaidRendering";

export function MarkdownMermaidBlock({ code, theme }: { code: string; theme: "light" | "dark" }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const [result, setResult] = useState<{
    code: string;
    theme: "light" | "dark";
    svg: string | null;
  } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void renderMermaidDiagram(code, theme).then(
      (svg) => {
        if (!cancelled) setResult({ code, theme, svg });
      },
      () => {
        if (!cancelled) setResult({ code, theme, svg: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code, theme, visible]);

  const current = result?.code === code && result.theme === theme ? result : null;
  return (
    <div ref={containerRef} className="chat-markdown-mermaid">
      {current?.svg ? (
        <div
          role="img"
          aria-label="Mermaid diagram"
          className="overflow-x-auto p-3 [&_svg]:mx-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: current.svg }}
        />
      ) : (
        <>
          <p className="px-3 pt-2 text-xs text-muted-foreground" role="status">
            {current
              ? "Unable to render this diagram. Showing source."
              : "Diagram preview loading…"}
          </p>
          <pre>
            <code className="language-mermaid">{code}</code>
          </pre>
        </>
      )}
    </div>
  );
}
