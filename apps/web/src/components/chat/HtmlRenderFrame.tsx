import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  type HtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import { Maximize2Icon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { type MouseEvent, type ToggleEvent, useEffect, useState } from "react";

import { useLongLivedAssetUrl } from "~/assets/longLivedAssetUrls";
import { cn } from "~/lib/utils";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { observeResize } from "~/lib/observeResize";

export function HtmlRenderFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly onFullscreenChange?: (fullscreen: boolean) => void;
}) {
  const { attachmentId, title } = props.htmlRender;
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  const observeBox = (box: HTMLDivElement) => {
    setWidth(box.clientWidth);
    return observeResize(box, ([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
  };
  const [expandedWidth, setExpandedWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  const measureExpanded = (box: HTMLDivElement) => {
    setExpandedWidth(box.clientWidth);
    return observeResize(box, ([entry]) => {
      // Rounded like clientWidth, so the two writes agree at fractional widths.
      if (entry) setExpandedWidth(Math.round(entry.contentRect.width));
    });
  };
  // Client fonts can exceed the server-measured height and cause nested scrolling.
  const [contentHeight, setContentHeight] = useState<number>();
  // Holds the timeline row at its inline height while the page is enlarged.
  const [expandedRowHeight, setExpandedRowHeight] = useState<number | null>(null);
  const expanded = expandedRowHeight !== null;
  const [zoom, setZoom] = useState(1);
  // Zoom divides the page's layout width, so the page reflows to fill the card
  // at every level, and the frame is as tall as the page so only the card scrolls.
  const height = htmlRenderFrameHeight(
    props.htmlRender,
    expanded ? expandedWidth / zoom : width,
    contentHeight,
  );
  const fileName = htmlRenderFileName(title);
  const resource = {
    _tag: "attachment" as const,
    attachmentId,
    fileName,
    mimeType: "text/html",
    disposition: "inline" as const,
  };
  // The frame keeps the first URL it loads, so later mints do not reload the page.
  const [src, setSrc] = useState<string | null>(null);
  const assetUrl = useLongLivedAssetUrl(src === null ? props.environmentId : null, resource);
  if (src === null && assetUrl._tag === "Success") setSrc(assetUrl.url);
  const failed = src === null && assetUrl._tag === "Failure";
  const { onFullscreenChange } = props;
  // Tied to the viewer's lifetime: unmounting while expanded must still release
  // the timeline's follow pin, which a close handler alone never reaches.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the parent's fullscreen pin while expanded and releases it on collapse or unmount
  useEffect(() => {
    if (!expanded) return;
    onFullscreenChange?.(true);
    return () => onFullscreenChange?.(false);
  }, [expanded, onFullscreenChange]);

  const collapse = () => setExpandedRowHeight(null);
  // The page's box enters the top layer exactly while the enlarged chrome is
  // mounted, so the same frame is shown without moving or reloading it.
  const attachExpandedChrome = (close: HTMLButtonElement) => {
    const box = close.closest<HTMLElement>("[popover]");
    if (box === null) return;
    if (!box.matches(":popover-open")) box.showPopover();
    close.focus();
    return () => {
      if (box.matches(":popover-open")) box.hidePopover();
    };
  };
  // Light dismiss (Escape) closes the popover without React.
  const onBoxToggle = (event: ToggleEvent<HTMLDivElement>) => {
    if (event.newState === "closed") collapse();
  };
  const onBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (expanded && event.target === event.currentTarget) collapse();
  };

  return (
    <div
      ref={observeBox}
      className="group/html-render relative"
      style={{ height: expandedRowHeight ?? height }}
    >
      {src !== null ? (
        <>
          <div
            // Preserve the frame's parent to avoid reloads; the top layer escapes timeline containment.
            popover="auto"
            onToggle={onBoxToggle}
            onClick={onBackdropClick}
            {...(expanded
              ? { role: "dialog", "aria-modal": true, "aria-label": `Expanded ${title} preview` }
              : {})}
            className={cn(
              "m-0 border-0 p-0 text-inherit",
              expanded
                ? "fixed inset-0 grid size-auto max-h-none max-w-none place-items-center overflow-hidden bg-black/75 px-4 pb-6 [-webkit-app-region:no-drag]"
                : "block! static! size-full bg-transparent",
            )}
            style={
              expanded
                ? { paddingTop: "calc(var(--native-titlebar-height, 0px) + 1.5rem)" }
                : undefined
            }
          >
            {/* 1144px is the widest the server measures a page; pages are written for the reply column and stretch badly beyond it. */}
            <div className={expanded ? "relative w-[min(92vw,1176px)]" : "size-full"}>
              {expanded ? (
                <Button
                  ref={attachExpandedChrome}
                  aria-label="Close"
                  size="icon-xs"
                  variant="media-close"
                  className="absolute right-0 -top-10 z-20"
                  onClick={collapse}
                >
                  <XIcon />
                </Button>
              ) : null}
              <div
                className={
                  expanded
                    ? "max-h-[min(86vh,calc(100vh-160px))] overflow-y-auto overscroll-contain rounded-lg bg-background p-4 shadow-2xl ring-1 ring-border/70"
                    : "size-full"
                }
              >
                <div ref={measureExpanded} className={expanded ? undefined : "size-full"}>
                  <div
                    className={expanded ? undefined : "size-full"}
                    style={expanded ? { zoom, height } : undefined}
                  >
                    <HtmlRenderDocument
                      src={src}
                      title={title}
                      threadRef={props.threadRef}
                      className="block size-full"
                      onContentHeight={setContentHeight}
                      onFullscreenChange={onFullscreenChange}
                    />
                  </div>
                </div>
              </div>
              {expanded ? (
                <div className="mt-2 flex min-w-0 items-center justify-center gap-3 text-xs text-white/80">
                  <span className="truncate">{title}</span>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      aria-label="Zoom out"
                      size="icon-sm"
                      variant="overlay"
                      disabled={zoom === 0.5}
                      onClick={() => setZoom((value) => value - 0.25)}
                    >
                      <MinusIcon />
                    </Button>
                    <Button
                      aria-label="Reset zoom"
                      size="sm"
                      variant="overlay"
                      onClick={() => setZoom(1)}
                    >
                      {Math.round(zoom * 100)}%
                    </Button>
                    <Button
                      aria-label="Zoom in"
                      size="icon-sm"
                      variant="overlay"
                      disabled={zoom === 2}
                      onClick={() => setZoom((value) => value + 0.25)}
                    >
                      <PlusIcon />
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <div className="absolute end-2 top-2 flex gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Open full screen"
                    size="icon-xs"
                    variant="glass"
                    onClick={() => {
                      setZoom(1);
                      setExpandedRowHeight(height);
                    }}
                  />
                }
              >
                <Maximize2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="left">Open full screen</TooltipPopup>
            </Tooltip>
          </div>
        </>
      ) : failed ? (
        <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
          Unable to load {title}
        </p>
      ) : null}
    </div>
  );
}
