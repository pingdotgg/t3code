import { LRUCache } from "./lruCache";

type MermaidTheme = "light" | "dark";

interface CachedMermaidSvg {
  svg: string;
  rootId: string;
}

const MAX_MERMAID_CACHE_ENTRIES = 200;
const MAX_MERMAID_CACHE_MEMORY_BYTES = 20 * 1024 * 1024;

const mermaidSvgCache = new LRUCache<CachedMermaidSvg>(
  MAX_MERMAID_CACHE_ENTRIES,
  MAX_MERMAID_CACHE_MEMORY_BYTES,
);

let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;
let initializedTheme: MermaidTheme | null = null;
let renderCount = 0;

function mermaidCacheKey(source: string, theme: MermaidTheme): string {
  return `${theme}:${source}`;
}

function nextMermaidId(): string {
  renderCount += 1;
  return `t3m_${renderCount}_`;
}

function cloneMermaidSvg(entry: CachedMermaidSvg): string {
  return entry.svg.replaceAll(entry.rootId, nextMermaidId());
}

function loadMermaid(): Promise<typeof import("mermaid")> {
  mermaidModulePromise ??= import("mermaid").catch((error: unknown) => {
    mermaidModulePromise = null;
    throw error;
  });
  return mermaidModulePromise;
}

function mermaidApi(mod: typeof import("mermaid")) {
  return mod.default;
}

export function getCachedMermaidSvg(source: string, theme: MermaidTheme): string | null {
  const cached = mermaidSvgCache.get(mermaidCacheKey(source, theme));
  return cached === null ? null : cloneMermaidSvg(cached);
}

export async function renderMermaidSvg(source: string, theme: MermaidTheme): Promise<string> {
  const cached = mermaidSvgCache.get(mermaidCacheKey(source, theme));
  if (cached !== null) return cloneMermaidSvg(cached);

  const mermaid = mermaidApi(await loadMermaid());
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // Failed mermaid.render() otherwise leaves a temp error diagram on
      // document.body (unique id per call, so later renders never reclaim it).
      suppressErrorRendering: true,
      htmlLabels: false,
      theme: theme === "dark" ? "dark" : "neutral",
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
      class: { useMaxWidth: false },
      state: { useMaxWidth: false },
      er: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
      pie: { useMaxWidth: false },
      gitGraph: { useMaxWidth: false },
      mindmap: { useMaxWidth: false },
    });
    initializedTheme = theme;
  }

  const rootId = nextMermaidId();
  const { svg } = await mermaid.render(rootId, source);
  mermaidSvgCache.set(mermaidCacheKey(source, theme), { svg, rootId }, svg.length * 2);
  return svg;
}

export function resetMermaidRendererForTests(): void {
  mermaidModulePromise = null;
  initializedTheme = null;
  renderCount = 0;
  mermaidSvgCache.clear();
}
