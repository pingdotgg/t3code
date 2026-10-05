import type { EnvironmentId } from "@t3tools/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  type HtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import { Maximize2Icon } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import type { ChatFileAttachment } from "~/types";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * An agent's HTML render inline in the thread: the page itself on the thread's
 * own background, at its measured height for this width (capped at the agent's
 * height). Loading and failure hold the same box so nothing below it moves.
 */
export function HtmlRenderFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly onOpen: (attachment: ChatFileAttachment) => void;
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
  const height = htmlRenderFrameHeight(props.htmlRender, width);
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
  // The page keeps the first URL it got, so later re-mints are not even requested.
  const [src, setSrc] = useState<string | null>(null);
  const assetUrl = useAssetUrlState(src === null ? props.environmentId : null, resource);
  if (src === null && assetUrl._tag === "Success") setSrc(assetUrl.url);

  return (
    <div ref={boxRef} className="group/html-render relative" style={{ height }}>
      {src !== null ? (
        <>
          <HtmlRenderDocument src={src} title={title} className="block size-full" />
          <div className="absolute end-2 top-2 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Open in panel"
                    size="icon-xs"
                    variant="glass"
                    onClick={() =>
                      props.onOpen({
                        type: "file",
                        id: attachmentId,
                        name: fileName,
                        mimeType: "text/html",
                        // Unknown here; the preview leaves it out.
                        sizeBytes: 0,
                        htmlRender: true,
                      })
                    }
                  />
                }
              >
                <Maximize2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="left">Open in panel</TooltipPopup>
            </Tooltip>
          </div>
        </>
      ) : assetUrl._tag === "Failure" ? (
        <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
          Unable to load {title}
        </p>
      ) : null}
    </div>
  );
}
