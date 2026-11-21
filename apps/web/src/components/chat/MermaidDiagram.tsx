import { T, useGT } from "gt-react";
import { memo, use, useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  CodeIcon,
  CopyIcon,
  ExpandIcon,
  MoonIcon,
  NetworkIcon,
  SunIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { renderMermaid } from "@lathe/client-runtime/mermaid-renderer";
import { mountDiagramViewport } from "@lathe/client-runtime/mermaid-viewport";
import { mermaidRepairPrompt } from "@lathe/client-runtime/mermaid";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTrigger } from "../ui/dialog";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { serializeCodeBlockToMarkdown } from "../../markdown-clipboard";
import { findRevealRef, MarkdownFindContext } from "./markdownFindContext";

type DiagramTheme = "dark" | "light";

/** Matches the renderer's `background` theme variable, so a copied image has no seam. */
const CANVAS_BACKGROUND: Record<DiagramTheme, string> = { dark: "#18181b", light: "#ffffff" };

function DiagramCanvas({
  svg,
  theme,
  onToggleTheme,
}: {
  svg: string;
  theme: DiagramTheme;
  onToggleTheme: () => void;
}) {
  const gt = useGT();
  const imageSource = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const canvas = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const controls = useRef<ReturnType<typeof mountDiagramViewport> | null>(null);
  const [scale, setScale] = useState(1);
  // oxlint-disable-next-line lathe/no-unreasoned-state-sync -- mounts the pan and zoom controller on the canvas and image elements and focuses the canvas
  useEffect(() => {
    if (!canvas.current || !image.current) return;
    const controller = mountDiagramViewport(canvas.current, image.current, svg, setScale);
    controls.current = controller;
    canvas.current.focus({ preventScroll: true });
    return () => {
      controller.dispose();
      controls.current = null;
    };
  }, [svg]);
  return (
    <>
      <div
        className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-2"
        aria-label={gt("Diagram controls")}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={gt("Zoom out")}
          onClick={() => controls.current?.zoom(1 / 1.2)}
        >
          <ZoomOutIcon />
        </Button>
        <output className="w-14 text-center text-xs tabular-nums" aria-label={gt("Zoom level")}>
          {Math.round(scale * 100)}%
        </output>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={gt("Zoom in")}
          onClick={() => controls.current?.zoom(1.2)}
        >
          <ZoomInIcon />
        </Button>
        <span className="mx-2 h-4 border-l border-border" />
        <Button variant="ghost" size="sm" onClick={() => controls.current?.fit()}>
          <T>Fit</T>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => controls.current?.center()}>
          <T>Center</T>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => controls.current?.actualSize()}>
          100%
        </Button>
        <span className="mx-2 h-4 border-l border-border" />
        <Button
          variant="ghost"
          size="sm"
          aria-label={
            theme === "dark" ? gt("Switch diagram to light") : gt("Switch diagram to dark")
          }
          aria-pressed={theme === "light"}
          onClick={onToggleTheme}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          {theme === "dark" ? gt("Light") : gt("Dark")}
        </Button>
      </div>
      <div
        ref={canvas}
        tabIndex={0}
        role="region"
        aria-label={gt("Diagram canvas")}
        aria-describedby="mermaid-viewer-help"
        data-diagram-theme={theme}
        className="relative min-h-0 flex-1 touch-none cursor-grab overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        style={{ backgroundColor: CANVAS_BACKGROUND[theme] }}
      >
        <img ref={image} src={imageSource} alt={gt("Mermaid diagram")} draggable={false} />
      </div>
      <p
        id="mermaid-viewer-help"
        className="border-t border-border px-4 py-3 text-xs text-muted-foreground"
      >
        <T>
          Drag to pan · Scroll or pinch to zoom · Arrow keys to pan · + / - zoom · F fit · C center
          · 0 actual size · Esc close
        </T>
      </p>
    </>
  );
}

/**
 * The expanded viewer owns its theme: it opens in the app's, and the toggle re-renders the source
 * in the other palette with a matching canvas, so a diagram can be copied light from a dark app.
 * The previous picture stays up until the new render lands, so the canvas never shows one palette
 * on the other's ground.
 */
export function ExpandedDiagram({
  source,
  theme: appTheme,
  svg: appSvg,
}: {
  source: string;
  theme: DiagramTheme;
  svg: string;
}) {
  const gt = useGT();
  const [viewerTheme, setViewerTheme] = useState<DiagramTheme>(appTheme);
  const [rendered, setRendered] = useState<{ theme: DiagramTheme; svg: string } | null>(null);
  const [failed, setFailed] = useState(false);
  // oxlint-disable-next-line lathe/no-unreasoned-state-sync -- renders the diagram through Mermaid in the viewer theme and drops stale results
  useEffect(() => {
    if (viewerTheme === appTheme) return;
    let cancelled = false;
    void renderMermaid(source, viewerTheme).then(
      (svg) => {
        if (!cancelled) setRendered({ theme: viewerTheme, svg });
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, viewerTheme, appTheme]);
  const shown =
    viewerTheme === appTheme
      ? { theme: appTheme, svg: appSvg }
      : rendered?.theme === viewerTheme
        ? rendered
        : { theme: appTheme, svg: appSvg };
  return (
    <>
      <DiagramCanvas
        svg={shown.svg}
        theme={shown.theme}
        onToggleTheme={() => {
          setFailed(false);
          setViewerTheme(viewerTheme === "dark" ? "light" : "dark");
        }}
      />
      {failed ? (
        <p role="status" className="border-t border-border px-4 py-2 text-xs text-destructive">
          {viewerTheme === "dark"
            ? gt("The dark version could not be rendered.")
            : gt("The light version could not be rendered.")}
        </p>
      ) : null}
    </>
  );
}

export const MermaidDiagram = memo(function MermaidDiagram({
  source,
  theme,
  pending,
  onRepair,
}: {
  source: string;
  theme: "dark" | "light";
  pending: boolean;
  onRepair?: ((prompt: string) => void) | undefined;
}) {
  const gt = useGT();
  const [result, setResult] = useState<{
    source: string;
    theme: string;
    attempt: number;
    svg?: string;
    error?: string;
  } | null>(null);
  const [showSource, setShowSource] = useState(false);
  const searching = use(MarkdownFindContext);
  const revealSource = () => setShowSource(true);
  const sourceRevealRef = findRevealRef(revealSource);
  const [copiedSource, setCopiedSource] = useState<string | null>(null);
  const copied = copiedSource === source;
  const [copyError, setCopyError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // oxlint-disable-next-line lathe/no-unreasoned-state-sync -- renders the diagram through Mermaid asynchronously and drops results for a stale source
  useEffect(() => {
    if (pending) return;
    let cancelled = false;
    void renderMermaid(source, theme).then(
      (svg) => {
        if (!cancelled) setResult({ source, theme, attempt, svg });
      },
      (error: unknown) => {
        if (!cancelled)
          setResult({
            source,
            theme,
            attempt,
            error:
              error instanceof Error ? error.message : gt("The diagram could not be rendered."),
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, theme, pending, attempt, gt]);
  const current =
    result?.source === source && result.theme === theme && result.attempt === attempt
      ? result
      : null;
  const svg = current?.svg;
  const imageSource = svg
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    : undefined;
  const error = pending ? undefined : current?.error;
  const copy = async () => {
    try {
      await writeTextToClipboard(source);
      setCopiedSource(source);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };
  return (
    <div
      className="my-3 overflow-hidden rounded-xl border border-border bg-card"
      data-mermaid-diagram=""
      data-markdown-mermaid=""
      data-markdown-copy={serializeCodeBlockToMarkdown(source, "mermaid")}
    >
      {/* Find counts only the source, so the chrome must not highlight either. */}
      <div
        data-thread-find-ignore
        className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-1.5"
      >
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <NetworkIcon className="size-3.5" />
          Mermaid
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={showSource ? gt("View diagram") : gt("View source")}
            aria-pressed={showSource}
            onClick={() => setShowSource(!showSource)}
          >
            <CodeIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={copied ? gt("Source copied") : gt("Copy source")}
            onClick={() => void copy()}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
          {svg && (
            <Dialog>
              <DialogTrigger
                render={<Button variant="ghost" size="sm" aria-label={gt("Expand diagram")} />}
              >
                <ExpandIcon />
                <T>Expand</T>
              </DialogTrigger>
              <DialogPopup
                className="flex h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col overflow-hidden"
                aria-label={gt("Mermaid diagram")}
                aria-describedby="mermaid-viewer-help"
                bottomStickOnMobile={false}
                initialFocus={false}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") event.stopPropagation();
                }}
              >
                <h2 className="border-b border-border px-4 py-4 text-sm leading-none font-semibold">
                  <T>Mermaid diagram</T>
                </h2>
                <ExpandedDiagram source={source} theme={theme} svg={svg} />
              </DialogPopup>
            </Dialog>
          )}
        </div>
      </div>
      {copyError && (
        <p data-thread-find-ignore role="status" className="px-4 py-2 text-xs text-destructive">
          <T>Could not copy. You can select the source below.</T>
        </p>
      )}
      {error ? (
        <div data-thread-find-ignore className="space-y-3 p-4">
          <p className="text-sm font-medium">
            <T>Couldn’t render this diagram</T>
          </p>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              <T>Error details</T>
            </summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{error}</pre>
          </details>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setResult(null);
                setAttempt((value) => value + 1);
              }}
            >
              <T>Retry</T>
            </Button>
            {onRepair && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onRepair(mermaidRepairPrompt(source, error))}
              >
                <T>Ask agent to fix</T>
              </Button>
            )}
          </div>
        </div>
      ) : !svg && !showSource ? (
        <div
          data-thread-find-ignore
          role="status"
          className="flex min-h-32 items-center justify-center p-6 text-xs text-muted-foreground"
        >
          {pending ? gt("Waiting for diagram…") : gt("Rendering diagram…")}
        </div>
      ) : null}
      {showSource || error || copyError ? (
        <pre className="m-0 max-h-96 overflow-auto border-t border-border bg-muted/30 p-4 text-xs">
          <code>{source}</code>
        </pre>
      ) : svg ? (
        <img
          className="mx-auto block max-h-[420px] max-w-full p-5"
          src={imageSource}
          alt={gt("Mermaid diagram")}
        />
      ) : null}
      {/* While find is open the source stays searchable; a selected match here shows it. */}
      {searching && !(showSource || error || copyError) ? (
        <pre ref={sourceRevealRef} hidden aria-hidden>
          {source}
        </pre>
      ) : null}
    </div>
  );
});
