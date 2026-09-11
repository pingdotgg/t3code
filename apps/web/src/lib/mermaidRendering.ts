let nextDiagramId = 0;
let renderQueue: Promise<unknown> = Promise.resolve();

/** Mermaid uses global configuration, so initialize and render each diagram together. */
export function renderMermaidDiagram(code: string, theme: "light" | "dark"): Promise<string> {
  const result = renderQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: theme === "dark" ? "dark" : "default",
    });
    const { svg } = await mermaid.render(`chat-mermaid-${++nextDiagramId}`, code);
    return svg;
  });
  renderQueue = result.catch(() => undefined);
  return result;
}
