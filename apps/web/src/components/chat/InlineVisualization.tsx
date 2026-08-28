import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { InlineVisualizationReference } from "@t3tools/shared/inlineVisualization";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";

const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:",
  "style-src 'unsafe-inline'",
  "img-src blob: data:",
  "font-src blob: data:",
  "worker-src blob:",
  "connect-src 'none'",
  "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
].join("; ");
// The trusted host allows only its generated blob child, so the nested
// visualization cannot navigate itself to a network URL.
const FRAME_HOST_CSP = FRAME_CSP.replace("frame-src 'none'", "frame-src blob:");
const FRAME_STYLES = `:root{color-scheme:light;--background:#fff;--foreground:#18181b;--muted:#f4f4f5;--muted-foreground:#71717a;--border:#e4e4e7;--viz-series-1:#2563eb;--viz-series-2:#7c3aed;--viz-series-3:#0891b2;--viz-series-4:#059669}html[data-theme=dark]{color-scheme:dark;--background:#18181b;--foreground:#fafafa;--muted:#27272a;--muted-foreground:#a1a1aa;--border:#3f3f46;--viz-series-1:#60a5fa;--viz-series-2:#a78bfa;--viz-series-3:#22d3ee;--viz-series-4:#34d399}*{box-sizing:border-box}html,body{margin:0;background:var(--background);color:var(--foreground);font:14px/1.5 system-ui,sans-serif}body{padding:16px;overflow-x:hidden}svg,img,canvas{max-width:100%}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid var(--border);text-align:left}code{font-family:ui-monospace,monospace}`;
const HEIGHT_MESSAGE = "t3-inline-visualization-height";
const HOST_THEME_TOKENS = [
  ["--background", "--background"],
  ["--foreground", "--foreground"],
  ["--muted", "--muted"],
  ["--muted-foreground", "--muted-foreground"],
  ["--border", "--border"],
  ["--viz-series-1", "--primary"],
  ["--viz-series-2", "--info"],
  ["--viz-series-3", "--success"],
  ["--viz-series-4", "--warning"],
] as const;

export function InlineVisualization(props: {
  readonly environmentId: EnvironmentId;
  readonly reference: InlineVisualizationReference;
  readonly theme: "light" | "dark";
  readonly threadRef: ScopedThreadRef;
}) {
  const asset = useAssetUrlState(props.environmentId, {
    _tag: "visualization",
    threadId: props.threadRef.threadId,
    path: props.reference.path,
  });
  const [fragment, setFragment] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(384);
  const [retryRevision, setRetryRevision] = useState(0);
  const [themeTokens, setThemeTokens] = useState("");
  const frameRef = useRef<HTMLIFrameElement>(null);
  const title = props.reference.title ?? visualizationTitle(props.reference.path);
  const assetUrl = asset._tag === "Success" ? asset.url : null;

  useEffect(() => {
    setFragment(null);
    setFailed(false);
    setHeight(384);
  }, [props.reference.path]);

  useEffect(() => {
    if (!assetUrl) return;
    setFailed(false);
    const controller = new AbortController();
    void fetch(assetUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Visualization request failed: ${response.status}`);
        return response.text();
      })
      .then((nextFragment) => {
        if (controller.signal.aborted) return;
        setFragment(nextFragment);
        setFailed(false);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setFailed(true);
      });
    return () => controller.abort();
  }, [assetUrl, retryRevision]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { readonly type?: unknown; readonly height?: unknown };
      if (data?.type !== HEIGHT_MESSAGE || typeof data.height !== "number") return;
      setHeight(Math.min(720, Math.max(240, Math.ceil(data.height))));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const syncThemeTokens = () => setThemeTokens(readHostThemeTokens());
    syncThemeTokens();
    const observer = new MutationObserver(syncThemeTokens);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme-id", "style"],
    });
    return () => observer.disconnect();
  }, []);

  const frameDocument = useMemo(
    () => (fragment === null ? null : renderDocument(fragment, props.theme, title, themeTokens)),
    [fragment, props.theme, themeTokens, title],
  );

  return (
    <div
      className={cn(
        "my-2 overflow-hidden rounded-xl border border-border/70 bg-background",
        props.reference.mode === "wide"
          ? "relative left-1/2 w-[min(64rem,max(100%,calc(100cqw-9.75rem)))] -translate-x-1/2"
          : "w-full max-w-3xl",
      )}
      data-inline-visualization=""
      data-inline-visualization-mode={props.reference.mode ?? "default"}
    >
      {asset._tag === "Failure" || failed ? (
        <div className="flex h-40 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
          <span>Visualization unavailable.</span>
          {failed ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRetryRevision((value) => value + 1)}
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : frameDocument === null ? (
        <Skeleton className="h-96 rounded-none" role="status" aria-label="Loading visualization" />
      ) : (
        <iframe
          ref={frameRef}
          srcDoc={frameDocument}
          title={title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="block w-full border-0 bg-background"
          style={{ height }}
        />
      )}
    </div>
  );
}

function visualizationTitle(path: string): string {
  const fileName = path.split(/[\\/]/u).at(-1) ?? "Visualization";
  return fileName.replace(/\.(?:html?|xhtml)$/iu, "").replaceAll("-", " ") || "Visualization";
}

function readHostThemeTokens(): string {
  const hostStyles = getComputedStyle(document.documentElement);
  return HOST_THEME_TOKENS.map(([target, source]) => {
    const value = hostStyles.getPropertyValue(source).trim();
    return value ? `${target}:${value}` : "";
  }).join(";");
}

function renderDocument(
  fragment: string,
  theme: "light" | "dark",
  title: string,
  themeTokens: string,
): string {
  const visualizationDocument = `<!doctype html><html lang="en" data-theme="${theme}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<style>${FRAME_STYLES}html[data-theme]{${themeTokens}}</style></head><body>
${fragment}
<script>(()=>{const send=()=>parent.postMessage({type:"${HEIGHT_MESSAGE}",height:document.documentElement.scrollHeight},"*");new ResizeObserver(send).observe(document.body);send()})()</script>
</body></html>`;
  return `<!doctype html><html><head>
<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_HOST_CSP}">
<style>html,body,iframe{width:100%;height:100%;margin:0;border:0}</style></head><body>
<iframe title="${escapeAttribute(title)}" sandbox="allow-scripts"></iframe>
<script>(()=>{const frame=document.querySelector("iframe");const url=URL.createObjectURL(new Blob([${serializeScriptString(visualizationDocument)}],{type:"text/html"}));frame.addEventListener("load",()=>URL.revokeObjectURL(url),{once:true});addEventListener("message",event=>{if(event.source===frame.contentWindow&&event.data?.type==="${HEIGHT_MESSAGE}"&&typeof event.data.height==="number")parent.postMessage(event.data,"*")});frame.src=url})()</script>
</body></html>`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function serializeScriptString(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
