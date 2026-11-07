import type { ScopedThreadRef } from "@t3tools/contracts";
import { MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useT } from "~/hooks/useI18n";
import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

export function HtmlRenderDialog(props: {
  readonly src: string;
  readonly title: string;
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly onClose: () => void;
}) {
  const t = useT();
  const [zoom, setZoom] = useState(1);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="row-start-1"
        initialFocus={closeButtonRef}
      >
        <DialogTitle className="sr-only">
          {t("chat.html.expanded", { title: props.title })}
        </DialogTitle>
        <div className="relative w-[92vw]">
          <Button
            ref={closeButtonRef}
            aria-label={t("chat.html.close")}
            size="icon-xs"
            variant="media-close"
            className="absolute right-0 -top-10 z-20"
            onClick={props.onClose}
          >
            <XIcon />
          </Button>
          <div className="h-[min(86vh,calc(100vh-160px))] overflow-auto overscroll-contain rounded-lg bg-background p-4 shadow-2xl ring-1 ring-border/70 [container-type:size]">
            <div className="h-[100cqh] w-[100cqw]" style={{ zoom }}>
              <HtmlRenderDocument
                src={props.src}
                title={props.title}
                threadRef={props.threadRef}
                className="block size-full"
              />
            </div>
          </div>
          <div className="mt-2 flex min-w-0 items-center justify-center gap-3 text-xs text-white/80">
            <span className="truncate">{props.title}</span>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                aria-label={t("chat.html.zoomOut")}
                size="icon-sm"
                variant="overlay"
                disabled={zoom === 0.5}
                onClick={() => setZoom((value) => value - 0.25)}
              >
                <MinusIcon />
              </Button>
              <Button
                aria-label={t("chat.html.resetZoom")}
                size="sm"
                variant="overlay"
                onClick={() => setZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </Button>
              <Button
                aria-label={t("chat.html.zoomIn")}
                size="icon-sm"
                variant="overlay"
                disabled={zoom === 2}
                onClick={() => setZoom((value) => value + 0.25)}
              >
                <PlusIcon />
              </Button>
            </div>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
