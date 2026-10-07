import type { EnvironmentId } from "@t3tools/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  type HtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import { ChevronRightIcon, ChevronUpIcon, Maximize2Icon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import type { ChatFileAttachment } from "~/types";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkLogButton } from "./WorkLog";

// A frame may load its URL a little after mounting.
const MIN_URL_LIFE_MS = 5 * 60_000;

/**
 * An agent's HTML render inline in the thread. Shown, it is the page itself on
 * the thread's own background, with minimize and open controls over its corner.
 * Minimized, the page is unmounted and a title row stands in for it. The
 * timeline owns `collapsed`; the published page is the same either way.
 */
export function HtmlRenderFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  readonly onOpen: (attachment: ChatFileAttachment) => void;
}) {
  const { attachmentId, title } = props.htmlRender;
  const fileName = htmlRenderFileName(title);
  // Minimize and the title row replace each other, so keyboard focus on one
  // moves to the other as it mounts instead of being dropped with the control
  // that left.
  const toggle = useRef<HTMLButtonElement | null>(null);
  const moveFocus = useRef(false);
  const toggleRef = useCallback((node: HTMLButtonElement | null) => {
    toggle.current = node;
    if (node === null || !moveFocus.current) return;
    moveFocus.current = false;
    node.focus({ preventScroll: true });
  }, []);
  const setCollapsed = (collapsed: boolean) => {
    moveFocus.current = toggle.current?.matches(":focus-visible") === true;
    props.onCollapsedChange(collapsed);
  };
  const open = () =>
    props.onOpen({
      type: "file",
      id: attachmentId,
      name: fileName,
      mimeType: "text/html",
      // Unknown here; the preview leaves it out.
      sizeBytes: 0,
      htmlRender: true,
    });

  if (props.collapsed) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <div className="min-w-0 flex-1">
          <WorkLogButton
            ref={toggleRef}
            aria-expanded={false}
            onClick={() => setCollapsed(false)}
            icon={<ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-icon-muted" />}
            label={title}
          />
        </div>
        <OpenInPanelButton variant="ghost" onOpen={open} />
      </div>
    );
  }

  return (
    <HtmlRenderPage
      environmentId={props.environmentId}
      htmlRender={props.htmlRender}
      fileName={fileName}
    >
      <div className="absolute end-2 top-2 flex gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                ref={toggleRef}
                aria-label="Minimize"
                aria-expanded
                size="icon-xs"
                variant="glass"
                onClick={() => setCollapsed(true)}
              />
            }
          >
            <ChevronUpIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>Minimize</TooltipPopup>
        </Tooltip>
        <OpenInPanelButton variant="glass" onOpen={open} />
      </div>
    </HtmlRenderPage>
  );
}

function OpenInPanelButton(props: {
  readonly variant: "glass" | "ghost";
  readonly onOpen: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Open in panel"
            size="icon-xs"
            variant={props.variant}
            onClick={props.onOpen}
          />
        }
      >
        <Maximize2Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup>Open in panel</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The mounted page, at the server's measured height for this width until the
 * page reports its own. Loading and failure hold the same box so nothing below
 * it moves, and `children` (the controls) stay over all three. It is mounted
 * only while the render is shown, so showing it again measures the new box and
 * applies the URL rules from the start.
 */
function HtmlRenderPage(props: {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly fileName: string;
  readonly children: ReactNode;
}) {
  const { attachmentId, title } = props.htmlRender;
  // The frame takes the page's measured height at its own width, read before
  // first paint so the reserved box is already the right size.
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  // Client fonts can wrap a page taller than the server measured it; a frame
  // left short would scroll inside the thread and take the reader's scroll.
  const [contentHeight, setContentHeight] = useState<number>();
  const height = htmlRenderFrameHeight(props.htmlRender, width, contentHeight);
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      fileName: props.fileName,
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId, props.fileName],
  );
  // A cached URL with life left is reused, so the browser's cache serves the
  // page again; one near expiry is minted afresh, since a frame cannot report a
  // failed load. The page keeps its first URL for its lifetime.
  const [src, setSrc] = useState<string | null>(null);
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
      {src !== null ? (
        <HtmlRenderDocument
          src={src}
          title={title}
          className="block size-full"
          onContentHeight={setContentHeight}
        />
      ) : failed ? (
        <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
          Unable to load {title}
        </p>
      ) : null}
      {props.children}
    </div>
  );
}
