import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseVisualizationHeight, visualizationDocument } from "../../html-visualization";
import { Button } from "../ui/button";

const THEME_VARIABLES = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "border",
  "ring",
  "success",
  "warning",
  "destructive",
  "info",
  "radius",
] as const;

export function HtmlVisualization({
  html,
  title,
  dark,
  children,
}: {
  html: string;
  title: string;
  dark: boolean;
  children: ReactNode;
}) {
  const [showSource, setShowSource] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [height, setHeight] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Theme changes travel through the bridge so open sections and checked controls survive.
  const document = useMemo(() => visualizationDocument(html, false), [html]);
  const syncTheme = useCallback(() => {
    if (!containerRef.current || !frameRef.current?.contentWindow) return;
    const styles = getComputedStyle(containerRef.current);
    const css = [
      ...THEME_VARIABLES.map((name) => `--${name}:${styles.getPropertyValue(`--${name}`)}`),
      `font-family:${styles.fontFamily}`,
      `font-size:${styles.fontSize}`,
      `line-height:${styles.lineHeight}`,
      `color:${styles.color}`,
      `color-scheme:${dark ? "dark" : "light"}`,
    ].join(";");
    frameRef.current.contentWindow.postMessage({ type: "t3-visualization-theme", css }, "*");
  }, [dark]);
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const receiveHeight = (event: MessageEvent<unknown>) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const next = parseVisualizationHeight(event.data);
      if (next !== null) setHeight(next);
    };
    window.addEventListener("message", receiveHeight);
    const observer = new MutationObserver(syncTheme);
    observer.observe(window.document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    syncTheme();
    return () => {
      window.removeEventListener("message", receiveHeight);
      observer.disconnect();
    };
  }, [syncTheme]);
  return (
    <div ref={containerRef} className="group/visualization my-[0.65rem] min-w-0">
      {showSource ? (
        children
      ) : (
        <iframe
          key={generation}
          ref={frameRef}
          title={title}
          srcDoc={document}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          onLoad={syncTheme}
          style={{ height: height ?? 160, visibility: height === null ? "hidden" : undefined }}
          className="block w-full border-0 bg-transparent"
        />
      )}
      <div className="mt-1 flex justify-end gap-1 text-muted-foreground opacity-100 sm:opacity-0 sm:group-hover/visualization:opacity-100 sm:group-focus-within/visualization:opacity-100">
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setShowSource((value) => !value)}
          aria-pressed={showSource}
        >
          {showSource ? "Show visualization" : "Show source"}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setGeneration((value) => value + 1)}
          disabled={showSource}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}
