import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { AssistantTextSelector } from "@t3tools/shared/assistantCitations";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderClearSelectionMessage,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  type HtmlRenderReference,
  type HtmlRenderSelection,
} from "@t3tools/shared/htmlRender";
import { T, useGT, Var } from "gt-react";
import { Maximize2Icon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useAssetUrlRefresh } from "~/assets/assetUrls";
import { useLongLivedAssetUrl } from "~/assets/longLivedAssetUrls";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CiteSelectionButton } from "./AssistantSelectionToolbar";
import { HtmlRenderDialog } from "./HtmlRenderDialog";
import { observeResize } from "~/lib/observeResize";

const MIN_URL_LIFE_MS = 5 * 60_000;
const MAX_MEASURED_CONTENT_HEIGHTS = 200;

const CITE_GAP = 4;

// One page offers Cite at a time; a selection in another page takes it over.
let dismissPageCite: (() => void) | null = null;

// The height each render's page last reported, so a remounted frame opens at it before its page loads.
const measuredContentHeights = new Map<string, number>();

function rememberContentHeight(attachmentId: string, height: number) {
  measuredContentHeights.delete(attachmentId);
  measuredContentHeights.set(attachmentId, height);
  if (measuredContentHeights.size > MAX_MEASURED_CONTENT_HEIGHTS) {
    const oldest = measuredContentHeights.keys().next().value;
    if (oldest !== undefined) measuredContentHeights.delete(oldest);
  }
}

export function HtmlRenderFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly onFullscreenChange?: (fullscreen: boolean) => void;
  /** Offers Cite for text the reader selects in the page. */
  readonly onCite?: ((selector: AssistantTextSelector) => boolean) | undefined;
}) {
  const gt = useGT();
  const { attachmentId, title } = props.htmlRender;
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  const observeBox = (box: HTMLDivElement) => {
    setWidth(box.clientWidth);
    return observeResize(box, ([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
  };
  // Client fonts can exceed the server-measured height and cause nested scrolling.
  const [contentHeight, setContentHeight] = useState(() =>
    measuredContentHeights.get(attachmentId),
  );
  const height = htmlRenderFrameHeight(props.htmlRender, width, contentHeight);
  const fileName = htmlRenderFileName(title);
  const resource = {
    _tag: "attachment" as const,
    attachmentId,
    fileName,
    mimeType: "text/html",
    disposition: "inline" as const,
  };
  // The frame keeps the first URL it loads, so later mints do not reload the page.
  const [loaded, setLoaded] = useState<{ src: string; expiresAt: number } | null>(null);
  const assetUrl = useLongLivedAssetUrl(loaded === null ? props.environmentId : null, resource);
  if (loaded === null && assetUrl._tag === "Success") {
    setLoaded({ src: assetUrl.url, expiresAt: assetUrl.expiresAt });
  }
  const src = loaded?.src ?? null;
  const failed = loaded === null && assetUrl._tag === "Failure";
  const refresh = useAssetUrlRefresh(props.environmentId, resource);
  const [expandedSrc, setExpandedSrc] = useState<string | null>(null);
  const [selection, setSelection] = useState<{
    readonly value: HtmlRenderSelection;
    readonly frame: HTMLIFrameElement;
  } | null>(null);
  const citeRef = useRef<HTMLButtonElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- dismisses Cite on a press elsewhere in the app, and hands the one Cite slot over from another page
  useEffect(() => {
    if (selection === null) return;
    const dismiss = () => setSelection(null);
    dismissPageCite?.();
    dismissPageCite = dismiss;
    const onPointerDown = (event: PointerEvent) => {
      if (!citeRef.current?.contains(event.target as Node)) dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      if (dismissPageCite === dismiss) dismissPageCite = null;
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [selection]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the Cite button and keeps it inside the frame, below the selection or above it, before paint
  useLayoutEffect(() => {
    const button = citeRef.current;
    if (!button || !selection) return;
    const { rect } = selection.value;
    const size = button.getBoundingClientRect();
    const below = rect.bottom + CITE_GAP;
    const top = below + size.height <= height ? below : rect.top - CITE_GAP - size.height;
    button.style.left = `${Math.max(0, Math.min(rect.right, width - size.width))}px`;
    button.style.top = `${Math.max(0, top)}px`;
  }, [height, selection, width]);
  const cite = () => {
    if (!selection || !props.onCite?.(selection.value.selector)) return;
    selection.frame.contentWindow?.postMessage(htmlRenderClearSelectionMessage(), "*");
    setSelection(null);
  };
  const { onFullscreenChange } = props;
  // Tied to the viewer's lifetime: unmounting while expanded must still release
  // the timeline's follow pin, which a close handler alone never reaches.
  const expanded = expandedSrc !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the parent's fullscreen pin while expanded and releases it on collapse or unmount
  useEffect(() => {
    if (!expanded) return;
    onFullscreenChange?.(true);
    return () => onFullscreenChange?.(false);
  }, [expanded, onFullscreenChange]);

  return (
    <div ref={observeBox} className="group/html-render relative" style={{ height }}>
      {src !== null ? (
        <>
          <HtmlRenderDocument
            src={src}
            title={title}
            threadRef={props.threadRef}
            className="block size-full"
            containScroll
            onContentHeight={(height) => {
              rememberContentHeight(attachmentId, height);
              setContentHeight(height);
            }}
            onFullscreenChange={onFullscreenChange}
            onSelection={
              props.onCite ? (value, frame) => setSelection(value && { value, frame }) : undefined
            }
          />
          {selection !== null ? (
            <CiteSelectionButton
              ref={citeRef}
              tooLong={selection.value.selector.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH}
              className="absolute z-10"
              style={{ left: selection.value.rect.right, top: selection.value.rect.bottom }}
              onCite={cite}
              onDismiss={() => setSelection(null)}
            />
          ) : null}
          <div className="absolute end-2 top-2 flex gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={gt("Open full screen")}
                    size="icon-xs"
                    variant="glass"
                    onClick={async () => {
                      const url =
                        loaded !== null && loaded.expiresAt - Date.now() > MIN_URL_LIFE_MS
                          ? src
                          : await refresh().catch(() => null);
                      if (url !== null) setExpandedSrc(url);
                      else
                        toastManager.add({
                          type: "error",
                          title: gt("Page unavailable"),
                          description: gt("Reconnect to the environment and try again."),
                        });
                    }}
                  />
                }
              >
                <Maximize2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="left">
                <T>Open full screen</T>
              </TooltipPopup>
            </Tooltip>
          </div>
          {expandedSrc !== null ? (
            <HtmlRenderDialog
              src={expandedSrc}
              htmlRender={props.htmlRender}
              threadRef={props.threadRef}
              onClose={() => setExpandedSrc(null)}
            />
          ) : null}
        </>
      ) : failed ? (
        <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
          <T>
            Unable to load <Var>{title}</Var>
          </T>
        </p>
      ) : null}
    </div>
  );
}
