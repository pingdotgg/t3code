import { useEffect, useId, useState, type ReactNode } from "react";
import type { RenderResult } from "mermaid";

import { serializeMarkdownCodeFence } from "../markdown-clipboard";

type MermaidTheme = "light" | "dark";

// Mermaid configuration is global, so initialization and rendering must stay paired.
let mermaidRenderQueue = Promise.resolve();

// The chat list unmounts off-screen rows. Without this, every scroll back past a
// diagram flashed the code fallback, re-ran Mermaid, and jumped the row height.
const MAX_CACHED_DIAGRAMS = 50;
const renderedDiagrams = new Map<string, string>();

function diagramCacheKey(theme: MermaidTheme, code: string) {
  return `${theme}\n${code}`;
}

function rememberRenderedDiagram(key: string, svg: string) {
  renderedDiagrams.delete(key);
  renderedDiagrams.set(key, svg);
  if (renderedDiagrams.size > MAX_CACHED_DIAGRAMS) {
    const oldest = renderedDiagrams.keys().next().value;
    if (oldest !== undefined) renderedDiagrams.delete(oldest);
  }
}

export function renderMermaidDiagram(
  id: string,
  code: string,
  theme: MermaidTheme,
  isActive: () => boolean = () => true,
) {
  const render = async () => {
    if (!isActive()) return null;
    const { default: mermaid } = await import("mermaid");
    if (!isActive()) return null;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "themeCSS",
        "fontFamily",
        "altFontFamily",
      ],
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
  const cacheKey = diagramCacheKey(theme, code);
  // Remounted per code and theme via key, so the stored result always matches.
  const [svg, setSvg] = useState<string | null>(() => renderedDiagrams.get(cacheKey) ?? null);

  useEffect(() => {
    if (renderedDiagrams.has(cacheKey)) return;
    let active = true;
    void renderMermaidDiagram(diagramId, code, theme, () => active).then(
      (result: RenderResult | null) => {
        if (!result) return;
        rememberRenderedDiagram(cacheKey, result.svg);
        if (active) setSvg(result.svg);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [cacheKey, code, diagramId, theme]);

  if (!svg) return fallback;

  return (
    <div
      className="chat-markdown-mermaid"
      data-markdown-copy={serializeMarkdownCodeFence(code, "mermaid")}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
