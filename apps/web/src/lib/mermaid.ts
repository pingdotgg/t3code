import { LRUCache } from "./lruCache";

export type MermaidTheme = "light" | "dark";

// Scrolling a long body remounts every diagram in it, and mermaid's layout pass is the
// expensive part. Keyed by the source itself: a hash collision would draw the wrong diagram.
const renderedSvgCache = new LRUCache<string>(64, 8 * 1024 * 1024);

/** The SVG from an earlier render of this diagram in this theme, so remounts draw at once. */
export function getCachedMermaidSvg(code: string, theme: MermaidTheme): string | null {
  return renderedSvgCache.get(`${theme}\n${code}`);
}

// Mermaid's config and render target are module-global, so renders join one chain instead
// of trampling each other's theme.
let renderQueue: Promise<unknown> = Promise.resolve();
let configuredTheme: MermaidTheme | null = null;
let renderCount = 0;

/** Renders on first use only: mermaid is far too large for the main bundle. */
export function renderMermaidSvg(code: string, theme: MermaidTheme): Promise<string> {
  const cached = getCachedMermaidSvg(code, theme);
  if (cached != null) return Promise.resolve(cached);

  const render = renderQueue.then(async () => {
    // Copies of one diagram queue together; the first one through fills the cache.
    const alreadyRendered = getCachedMermaidSvg(code, theme);
    if (alreadyRendered != null) return alreadyRendered;

    const { default: mermaid } = await import("mermaid");
    if (configuredTheme !== theme) {
      mermaid.initialize({
        startOnLoad: false,
        // Pull request bodies are attacker-controlled: keep DOMPurify on and click/script off.
        securityLevel: "strict",
        // Otherwise mermaid injects its own error graph next to the React fallback.
        suppressErrorRendering: true,
        theme: theme === "dark" ? "dark" : "default",
      });
      configuredTheme = theme;
    }
    renderCount += 1;
    const { svg } = await mermaid.render(`markdown-mermaid-${renderCount}`, code);
    renderedSvgCache.set(`${theme}\n${code}`, svg, svg.length * 2);
    return svg;
  });

  // A failed diagram must not poison the queue for the next one.
  renderQueue = render.catch(() => undefined);
  return render;
}
