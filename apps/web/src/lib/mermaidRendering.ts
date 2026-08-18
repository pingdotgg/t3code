/**
 * Lazy mermaid rendering for chat markdown fences.
 *
 * Web and desktop share this path (desktop wraps the web client). Mobile has
 * no DOM mermaid runtime, so mermaid fences stay ordinary code blocks there.
 */
import { fnv1a32 } from "./diffRendering";
import { LRUCache } from "./lruCache";
import { mermaidSvgContentSize } from "./mermaidViewport";

const MAX_MERMAID_CACHE_ENTRIES = 80;
const MAX_MERMAID_CACHE_MEMORY_BYTES = 8 * 1024 * 1024;

const mermaidSvgCache = new LRUCache<string>(
  MAX_MERMAID_CACHE_ENTRIES,
  MAX_MERMAID_CACHE_MEMORY_BYTES,
);

const MERMAID_FENCE_LANGUAGES = new Set(["mermaid", "mmd"]);

export type MermaidColorScheme = "light" | "dark";

export interface MermaidRuntime {
  initialize: (config: Record<string, unknown>) => void;
  parse: (text: string) => Promise<unknown>;
  render: (id: string, text: string) => Promise<{ svg: string }>;
}

let mermaidRuntimePromise: Promise<MermaidRuntime> | null = null;
let renderQueue: Promise<void> = Promise.resolve();
let mermaidRenderSeq = 0;

function defaultLoadMermaid(): Promise<MermaidRuntime> {
  return import("mermaid").then((module) => module.default as MermaidRuntime);
}

let loadMermaid = defaultLoadMermaid;

function getMermaidRuntime(): Promise<MermaidRuntime> {
  mermaidRuntimePromise ??= loadMermaid().then(
    (runtime) => runtime,
    (error: unknown) => {
      mermaidRuntimePromise = null;
      throw error;
    },
  );
  return mermaidRuntimePromise;
}

function enqueueMermaidWork<T>(work: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(work, work);
  renderQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function mermaidConfig(theme: MermaidColorScheme): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    // Diagram `%%{init}%%` / frontmatter must not be able to loosen this.
    secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "htmlLabels"],
    suppressErrorRendering: true,
    logLevel: "fatal",
    theme: theme === "dark" ? "dark" : "neutral",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    flowchart: { useMaxWidth: true },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
    class: { useMaxWidth: true },
    state: { useMaxWidth: true },
    er: { useMaxWidth: true },
    pie: { useMaxWidth: true },
    journey: { useMaxWidth: true },
    gitGraph: { useMaxWidth: true },
  };
}

function nextMermaidDomId(): string {
  mermaidRenderSeq += 1;
  return `t3-mermaid-${mermaidRenderSeq}`;
}

function createMermaidCacheKey(code: string, theme: MermaidColorScheme): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${theme}`;
}

export function isMermaidFenceLanguage(language: string | undefined): boolean {
  if (!language) return false;
  return MERMAID_FENCE_LANGUAGES.has(language.trim().toLowerCase());
}

export function mermaidSourceAsMarkdownFence(code: string): string {
  const body = code.replace(/\n$/, "");
  const longestRun = [...(body.match(/`{3,}/g) ?? [])].reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}mermaid\n${body}\n${fence}`;
}

/**
 * Strict-mode mermaid should not emit scripts, but the SVG still lands in the
 * chat DOM via innerHTML. Strip the obvious handlers so a mermaid bug cannot
 * become an XSS gadget.
 */
export function sanitizeMermaidSvg(svg: string): string {
  return svg
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<script\b[^>]*\/>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<iframe\b[^>]*\/>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /\s+(?:xlink:)?href\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:\S+)/gi,
      "",
    );
}

/**
 * Inline chat and the expand overlay both mount the same mermaid SVG. Rewrite
 * ids so marker/gradient `url(#…)` refs and the `<style>` selectors mermaid
 * emits (`#t3-mermaid-1 .nodeLabel`) do not collide with the preview still on
 * the page. Skipping the stylesheet is what turned overlay nodes into black
 * boxes with inherited (also black) label text.
 */
export function remapMermaidSvgIds(svg: string, suffix: string): string {
  if (suffix.length === 0) return svg;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of svg.matchAll(/\bid="([^"]+)"/g)) {
    const id = match[1];
    if (id == null || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  ids.sort((left, right) => right.length - left.length);
  let remapped = svg;
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const next = `${id}${suffix}`;
    remapped = remapped.replace(new RegExp(`id="${escaped}"`, "g"), `id="${next}"`);
    remapped = remapped.replace(new RegExp(`url\\(#${escaped}\\)`, "g"), `url(#${next})`);
    remapped = remapped.replace(new RegExp(`href="#${escaped}"`, "g"), `href="#${next}"`);
    remapped = remapped.replace(
      new RegExp(`xlink:href="#${escaped}"`, "g"),
      `xlink:href="#${next}"`,
    );
    // Mermaid themes live in a <style> block keyed by the root svg id.
    remapped = remapped.replace(new RegExp(`#${escaped}(?=[^A-Za-z0-9_-]|$)`, "g"), `#${next}`);
  }
  return remapped;
}

/**
 * Mermaid emits `width="100%"` plus an inline max-width so the chat preview can
 * shrink. The overlay needs a real pixel box or scale() has nothing to zoom.
 */
export function pinMermaidSvgIntrinsicSize(svg: string): string {
  const size = mermaidSvgContentSize(svg);
  if (size == null) return svg;
  return svg.replace(/<svg\b([^>]*)>/i, (_full, attrs: string) => {
    let next = attrs
      .replace(/\swidth\s*=\s*("[^"]*"|'[^']*')/i, "")
      .replace(/\sheight\s*=\s*("[^"]*"|'[^']*')/i, "");
    next = next.replace(
      /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i,
      (_styleFull, _quoted, double: string | undefined, single: string | undefined) => {
        const style = (double ?? single ?? "")
          .replace(/max-width\s*:\s*[^;]+;?/gi, "")
          .replace(/max-height\s*:\s*[^;]+;?/gi, "")
          .replace(/(?:^|;)\s*width\s*:\s*[^;]+;?/gi, ";")
          .replace(/(?:^|;)\s*height\s*:\s*[^;]+;?/gi, ";")
          .replace(/^;+|;+$/g, "")
          .trim();
        return style.length > 0 ? ` style="${style}"` : "";
      },
    );
    return `<svg width="${size.width}" height="${size.height}"${next}>`;
  });
}

export function prepareMermaidOverlaySvg(svg: string, suffix: string): string {
  return pinMermaidSvgIntrinsicSize(remapMermaidSvgIds(svg, suffix));
}

export class MermaidRenderError extends Error {
  override readonly name = "MermaidRenderError";

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Couldn't render this diagram.");
    this.cause = cause;
  }
}

export async function renderMermaidSvg(code: string, theme: MermaidColorScheme): Promise<string> {
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    throw new MermaidRenderError(new Error("Diagram is empty."));
  }

  const cacheKey = createMermaidCacheKey(trimmed, theme);
  const cached = mermaidSvgCache.get(cacheKey);
  if (cached != null) return cached;

  const svg = await enqueueMermaidWork(async () => {
    const cachedDuringWait = mermaidSvgCache.get(cacheKey);
    if (cachedDuringWait != null) return cachedDuringWait;

    const mermaid = await getMermaidRuntime();
    mermaid.initialize(mermaidConfig(theme));
    try {
      await mermaid.parse(trimmed);
      const { svg } = await mermaid.render(nextMermaidDomId(), trimmed);
      const sanitized = sanitizeMermaidSvg(svg);
      mermaidSvgCache.set(cacheKey, sanitized, Math.max(sanitized.length * 2, trimmed.length));
      return sanitized;
    } catch (cause) {
      throw new MermaidRenderError(cause);
    }
  });

  return svg;
}

export function __setMermaidLoaderForTests(loader: (() => Promise<MermaidRuntime>) | null): void {
  loadMermaid = loader ?? defaultLoadMermaid;
  mermaidRuntimePromise = null;
}

export function __resetMermaidRenderingForTests(): void {
  mermaidSvgCache.clear();
  mermaidRuntimePromise = null;
  renderQueue = Promise.resolve();
  mermaidRenderSeq = 0;
  loadMermaid = defaultLoadMermaid;
}
