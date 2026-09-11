import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, CopyIcon, XIcon } from "lucide-react";
import type { RenderResult } from "mermaid";

import { serializeMarkdownCodeFence } from "../markdown-clipboard";
import { Button } from "./ui/button";
import { composerFloatingLayerProps } from "./chat/composerEventScope";
import { isContextMenuOpen } from "../contextMenuFallback";

export type MermaidTheme = "light" | "dark";

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

/**
 * Stores a rendered diagram so remounts (e.g. scrolling back in chat) reuse
 * it instead of re-running Mermaid. Exported for tests.
 */
export function cacheRenderedDiagram(theme: MermaidTheme, code: string, svg: string) {
  rememberRenderedDiagram(diagramCacheKey(theme, code), svg);
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

function mermaidErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return "Couldn't render diagram.";
}

const MERMAID_VIEWBOX_PATTERN = /<svg[^>]*\bviewBox\s*=\s*"([^"]+)"/;

/**
 * Natural pixel size from the SVG viewBox. Mermaid emits `width="100%"`, so
 * without this the expanded overlay can only shrink-to-fit and collapses
 * wide diagrams. Pure string parsing: no DOM needed, SSR-safe.
 */
export function mermaidSvgNaturalSize(svg: string): { width: number; height: number } | null {
  const viewBox = MERMAID_VIEWBOX_PATTERN.exec(svg)?.[1];
  const dimensions = viewBox?.trim().split(/\s+/).map(Number);
  const width = dimensions?.[2];
  const height = dimensions?.[3];
  if (
    dimensions?.length !== 4 ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    (width ?? 0) <= 0 ||
    (height ?? 0) <= 0
  ) {
    return null;
  }
  return { width: width as number, height: height as number };
}

export function MermaidDiagramDialog({
  svg,
  copyMarkdown,
  onClose,
}: {
  svg: string;
  copyMarkdown: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(copyMarkdown)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  }, [copyMarkdown]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  // The element that opened the preview gets focus back on close. Without
  // this a close leaves focus on the unmounted dialog.
  const openerRef = useRef<Element | null>(null);
  useEffect(() => {
    openerRef.current = document.activeElement;
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || isContextMenuOpen()) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Definite container width so the SVG's `width="100%"` resolves to its
  // natural size instead of collapsing in the shrink-to-fit flex layout.
  // Capped by max-w-[92vw]; larger diagrams scroll inside the overlay.
  const naturalSize = useMemo(() => mermaidSvgNaturalSize(svg), [svg]);

  const dialog = (
    <div
      {...composerFloatingLayerProps}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded diagram preview"
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close diagram preview"
        onClick={onClose}
      />
      <div className="relative isolate z-10 flex max-h-[92vh] max-w-[92vw] flex-col">
        <div className="mb-2 flex items-center justify-end gap-1">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="text-white/90 hover:bg-white/10 hover:text-white"
            onClick={handleCopy}
            aria-label={copied ? "Copied" : "Copy diagram source"}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="text-white/90 hover:bg-white/10 hover:text-white"
            onClick={onClose}
            aria-label="Close diagram preview"
          >
            <XIcon />
          </Button>
        </div>
        <div
          className="chat-markdown-mermaid chat-markdown-mermaid-dialog min-h-0 overflow-auto rounded-lg border border-border/70 bg-background p-4 shadow-2xl"
          style={naturalSize ? { width: naturalSize.width } : undefined}
          data-markdown-copy={copyMarkdown}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
  // Portals keep the overlay out of clipped chat-row stacking contexts. Fall
  // back to inline rendering where `document` is unavailable (SSR/tests).
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

export function MermaidDiagram({
  code,
  language = "mermaid",
  theme,
  fallback,
  onError,
}: {
  code: string;
  language?: string;
  theme: MermaidTheme;
  fallback: ReactNode;
  onError?: (message: string) => void;
}) {
  const reactId = useId();
  const diagramId = `t3-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const cacheKey = diagramCacheKey(theme, code);
  // Remounted per code and theme via key, so the stored result always matches.
  const [svg, setSvg] = useState<string | null>(() => renderedDiagrams.get(cacheKey) ?? null);
  const [expanded, setExpanded] = useState(false);
  const copyMarkdown = serializeMarkdownCodeFence(code, language);
  // Mermaid runs only for diagrams at or near the viewport. Chat unmounts
  // far rows, but file previews and PR bodies mount whole documents, so
  // without this every diagram below the fold would render on open.
  const [inView, setInView] = useState(
    () => renderedDiagrams.has(cacheKey) || typeof IntersectionObserver === "undefined",
  );
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Adopt a diagram cached after this mount's initializers ran (a sibling won
  // the render race). Render-phase adjustment, not an effect, so no extra
  // commit cycle and no work while streaming lists re-render around us.
  const cachedSvg = renderedDiagrams.get(cacheKey);
  if (cachedSvg !== undefined && cachedSvg !== svg) {
    setSvg(cachedSvg);
  }
  if (!inView && cachedSvg !== undefined) {
    setInView(true);
  }

  useEffect(() => {
    if (inView) return undefined;
    const host = hostRef.current;
    if (host === null) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      // Start rendering just before the diagram scrolls into view.
      { rootMargin: "400px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
    // cacheKey omitted: the parent remounts per code and theme, so it never
    // changes within a mount and would only refire the observer for nothing.
  }, [inView]);

  useEffect(() => {
    if (!inView || svg !== null) return undefined;
    let active = true;
    void renderMermaidDiagram(diagramId, code, theme, () => active).then(
      (result: RenderResult | null) => {
        if (!result) return;
        rememberRenderedDiagram(cacheKey, result.svg);
        if (active) setSvg(result.svg);
      },
      (cause: unknown) => {
        if (!active) return;
        onError?.(mermaidErrorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [cacheKey, code, diagramId, inView, onError, svg, theme]);

  if (!svg) {
    // Pre-render (code fallback) doubles as the observation host so the
    // diagram starts rendering just before it scrolls into view.
    return <div ref={hostRef}>{fallback}</div>;
  }

  return (
    <>
      <div
        className="chat-markdown-mermaid cursor-zoom-in"
        data-markdown-copy={copyMarkdown}
        role="button"
        tabIndex={0}
        aria-label="Expand diagram"
        onClick={(event) => {
          // Links inside the SVG (e.g. `click node href`) keep working, and a
          // drag that selects diagram text must not pop the overlay open.
          if (event.target instanceof Element && event.target.closest("a") !== null) return;
          const selection = window.getSelection();
          if (selection !== null && !selection.isCollapsed) return;
          setExpanded(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setExpanded(true);
          }
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {expanded ? (
        <MermaidDiagramDialog
          svg={svg}
          copyMarkdown={copyMarkdown}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </>
  );
}
