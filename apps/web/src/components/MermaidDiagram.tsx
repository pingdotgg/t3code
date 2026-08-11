import { useEffect, useId, useState, type ReactNode } from "react";
import type { RenderResult } from "mermaid";

type MermaidTheme = "light" | "dark";

// Mermaid configuration is global, so initialization and rendering must stay paired.
let mermaidRenderQueue = Promise.resolve();

export function renderMermaidDiagram(id: string, code: string, theme: MermaidTheme) {
  const render = async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: theme === "dark" ? "dark" : "default",
    });
    return mermaid.render(id, code);
  };

  const result = mermaidRenderQueue.then(render, render);
  mermaidRenderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function MermaidDiagram({
  code,
  theme,
  fallback,
}: {
  code: string;
  theme: MermaidTheme;
  fallback: ReactNode;
}) {
  const reactId = useId();
  const diagramId = `t3-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const inputKey = `${theme}\0${code}`;
  const [renderState, setRenderState] = useState<{
    inputKey: string;
    result: RenderResult;
  } | null>(null);
  const result = renderState?.inputKey === inputKey ? renderState.result : null;

  useEffect(() => {
    let active = true;
    void renderMermaidDiagram(diagramId, code, theme).then(
      (nextResult) => {
        if (active) setRenderState({ inputKey, result: nextResult });
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [code, diagramId, inputKey, theme]);

  if (!result) return fallback;

  const markdownSource = `\`\`\`mermaid\n${code.replace(/\n$/, "")}\n\`\`\`\n\n`;
  return (
    <div
      className="chat-markdown-mermaid"
      data-markdown-copy={markdownSource}
      dangerouslySetInnerHTML={{ __html: result.svg }}
    />
  );
}
