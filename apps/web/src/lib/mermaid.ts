import { LRUCache } from "./lruCache";

export type MermaidTheme = "light" | "dark";

/**
 * GitHub renders only the `mermaid` fence as a diagram — no aliases — but it matches the fence
 * info string case-insensitively, so ```Mermaid counts.
 */
export function isMermaidFenceLanguage(language: string): boolean {
  return language.toLowerCase() === "mermaid";
}

/**
 * Rendered SVG keyed by source + theme. Diagrams are re-rendered whenever a body scrolls
 * back into view or a comment list re-mounts, and mermaid's layout pass is the expensive
 * part, so the cache is what keeps repeat renders free.
 */
const renderedSvgCache = new LRUCache<string>(64, 8 * 1024 * 1024);

/**
 * The source itself, not a hash of it: a diagram body is small, and a hash collision here would
 * silently draw one pull request's diagram in place of another's.
 */
function cacheKey(code: string, theme: MermaidTheme): string {
  return `${theme}\n${code}`;
}

export function getCachedMermaidSvg(code: string, theme: MermaidTheme): string | null {
  return renderedSvgCache.get(cacheKey(code, theme));
}

type MermaidApi = typeof import("mermaid").default;

let mermaidPromise: Promise<MermaidApi> | null = null;

/**
 * Mermaid pulls in its own parser, dagre, and cytoscape — a chunk far too large to sit in the
 * main bundle for the few bodies that contain a diagram. Import it on first render only.
 */
function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import("mermaid")
    .then((module) => module.default)
    .catch((cause) => {
      mermaidPromise = null;
      throw cause;
    });
  return mermaidPromise;
}

function mermaidConfig(theme: MermaidTheme) {
  return {
    startOnLoad: false,
    // Pull request bodies are attacker-controlled text: keep mermaid's DOMPurify pass on and
    // its click/script directives off.
    securityLevel: "strict",
    // Without this mermaid injects its own error diagram into the DOM node it created,
    // which would race the React-rendered source fallback.
    suppressErrorRendering: true,
    theme: theme === "dark" ? "dark" : "default",
    fontFamily: "var(--font-sans, ui-sans-serif, system-ui, sans-serif)",
  } as const;
}

// Mermaid's config and its render target are module-global, so concurrent renders would
// trample each other's theme. Every render joins one chain instead.
let renderQueue: Promise<unknown> = Promise.resolve();
let configuredTheme: MermaidTheme | null = null;
let renderCount = 0;

export function renderMermaidSvg(code: string, theme: MermaidTheme): Promise<string> {
  const key = cacheKey(code, theme);
  const cached = renderedSvgCache.get(key);
  if (cached != null) return Promise.resolve(cached);

  const render = renderQueue.then(async () => {
    // Several copies of the same diagram queue together; the first one through fills the cache.
    const alreadyRendered = renderedSvgCache.get(key);
    if (alreadyRendered != null) return alreadyRendered;

    const mermaid = await loadMermaid();
    if (configuredTheme !== theme) {
      mermaid.initialize(mermaidConfig(theme));
      configuredTheme = theme;
    }
    renderCount += 1;
    const { svg } = await mermaid.render(`markdown-mermaid-${renderCount}`, code);
    renderedSvgCache.set(key, svg, svg.length * 2);
    return svg;
  });

  // A failed diagram must not poison the queue for the next one.
  renderQueue = render.then(
    () => undefined,
    () => undefined,
  );
  return render;
}
