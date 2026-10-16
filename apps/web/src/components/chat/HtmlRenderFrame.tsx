import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderOutlineBoxes,
  type HtmlRenderOutlineBox,
  type HtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import { Maximize2Icon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HtmlRenderDialog } from "./HtmlRenderDialog";
import { observeResize } from "~/lib/observeResize";

const MIN_URL_LIFE_MS = 5 * 60_000;

export function HtmlRenderFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly onFullscreenChange?: (fullscreen: boolean) => void;
}) {
  const { attachmentId, title } = props.htmlRender;
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    return observeResize(box, ([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
  }, []);
  // Client fonts can wrap a page taller than the server measured it; a frame
  // left short would scroll inside the thread and take the reader's scroll.
  const [contentHeight, setContentHeight] = useState<number>();
  const height = htmlRenderFrameHeight(props.htmlRender, width, contentHeight);
  const fileName = htmlRenderFileName(title);
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      fileName,
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId, fileName],
  );
  // A cached URL with life left is reused, so the browser's cache serves the
  // page again; one near expiry is minted afresh, since a frame cannot report a
  // failed load.
  const [src, setSrc] = useState<string | null>(null);
  const srcExpiresAt = useRef(0);
  const [expandedSrc, setExpandedSrc] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const showPage = useCallback(() => setReady(true), []);
  const fitPage = useCallback((contentHeight: number) => {
    setContentHeight(contentHeight);
    setReady(true);
  }, []);
  const { onFullscreenChange } = props;
  useEffect(() => {
    if (expandedSrc === null) return;
    onFullscreenChange?.(true);
    return () => onFullscreenChange?.(false);
  }, [expandedSrc, onFullscreenChange]);
  const [failed, setFailed] = useState(false);
  const assetUrl = useAssetUrlState(src === null ? props.environmentId : null, resource);
  const cachedUrl = assetUrl._tag === "Success" ? assetUrl.url : null;
  const cachedExpiresAt = assetUrl._tag === "Success" ? assetUrl.expiresAt : 0;
  const cacheFailed = assetUrl._tag === "Failure";
  const refresh = useAssetUrlRefresh(props.environmentId, resource);
  // At most one mint per mount: expiry is server time and the check uses the
  // client clock, so a skewed clock must not mint again on every update.
  const minting = useRef(false);
  useEffect(() => {
    if (src !== null || minting.current) return;
    if (cacheFailed) {
      // oxlint-disable-next-line react/set-state-in-effect -- Mirrors the cached URL's failure.
      setFailed(true);
      return;
    }
    if (cachedUrl === null) return;
    if (cachedExpiresAt - Date.now() > MIN_URL_LIFE_MS) {
      srcExpiresAt.current = cachedExpiresAt;
      setSrc(cachedUrl);
      return;
    }
    minting.current = true;
    void refresh().then(
      (url) => (url === null ? setFailed(true) : setSrc(url)),
      () => setFailed(true),
    );
  }, [cacheFailed, cachedExpiresAt, cachedUrl, refresh, src]);

  return (
    <div ref={boxRef} className="group/html-render relative" style={{ height }}>
      {!ready && !failed ? (
        <HtmlRenderSkeleton
          title={title}
          height={height}
          outline={htmlRenderOutlineBoxes(props.htmlRender, width)}
        />
      ) : null}
      {src !== null ? (
        <>
          <HtmlRenderDocument
            src={src}
            title={title}
            threadRef={props.threadRef}
            className={cn(
              "block size-full motion-safe:transition-opacity motion-safe:duration-200",
              !ready && "opacity-0",
            )}
            onContentHeight={fitPage}
            onLoad={showPage}
            onFullscreenChange={onFullscreenChange}
          />
          <div className="absolute end-2 top-2 flex gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Open full screen"
                    size="icon-xs"
                    variant="glass"
                    onClick={async () => {
                      const url =
                        srcExpiresAt.current - Date.now() > MIN_URL_LIFE_MS
                          ? src
                          : await refresh().catch(() => null);
                      if (url !== null) setExpandedSrc(url);
                      else
                        toastManager.add({
                          type: "error",
                          title: "Page unavailable",
                          description: "Reconnect to the environment and try again.",
                        });
                    }}
                  />
                }
              >
                <Maximize2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="left">Open full screen</TooltipPopup>
            </Tooltip>
          </div>
          {expandedSrc !== null ? (
            <HtmlRenderDialog
              src={expandedSrc}
              title={title}
              threadRef={props.threadRef}
              onClose={() => setExpandedSrc(null)}
            />
          ) : null}
        </>
      ) : failed ? (
        <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
          Unable to load {title}
        </p>
      ) : null}
    </div>
  );
}

const SKELETON_SECTION_HEIGHT = 264;

const OUTLINE_BOX_CLASS = {
  media: "rounded-lg bg-muted-foreground/15",
  text: "",
  table: "",
} as const;

const OUTLINE_BAR = "color-mix(in srgb, var(--color-muted-foreground) 15%, transparent)";

function outlineBoxStyle(box: HtmlRenderOutlineBox): React.CSSProperties {
  const style: React.CSSProperties = {
    left: box.x,
    top: box.y,
    width: box.width,
    height: box.height,
  };
  if (box.kind !== "text" && box.kind !== "table") return style;
  const step = box.height / box.lines;
  const bar = Math.min(box.kind === "table" ? 12 : 10, step * 0.6);
  const start = (step - bar) / 2;
  return {
    ...style,
    backgroundImage: `repeating-linear-gradient(to bottom, transparent 0 ${start}px, ${OUTLINE_BAR} ${start}px ${start + bar}px, transparent ${start + bar}px ${step}px)`,
  };
}

function HtmlRenderSkeleton(props: {
  readonly title: string;
  readonly height: number;
  readonly outline: ReadonlyArray<HtmlRenderOutlineBox>;
}) {
  if (props.outline.length > 0) {
    return (
      <div
        role="status"
        aria-label={`Loading ${props.title}`}
        className="pointer-events-none absolute inset-0 overflow-hidden motion-safe:animate-skeleton"
      >
        {props.outline.map((box) => (
          <div
            key={`${box.kind}:${box.x}:${box.y}:${box.width}:${box.height}`}
            className={cn("absolute", OUTLINE_BOX_CLASS[box.kind])}
            style={outlineBoxStyle(box)}
          />
        ))}
      </div>
    );
  }
  const sections = Math.ceil(props.height / SKELETON_SECTION_HEIGHT);
  return (
    <div
      role="status"
      aria-label={`Loading ${props.title}`}
      className="pointer-events-none absolute inset-0 flex flex-col gap-6 overflow-hidden pt-1"
    >
      {Array.from({ length: sections }, (_, index) => (
        <div key={index} className="flex shrink-0 flex-col gap-2">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-3 w-3/5" />
          <Skeleton shape="card" className="mt-2 h-40 w-full" />
        </div>
      ))}
    </div>
  );
}
