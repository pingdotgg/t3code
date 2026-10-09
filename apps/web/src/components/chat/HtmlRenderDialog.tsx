import { MinusIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";

export function HtmlRenderDialog(props: {
  readonly src: string;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup variant="fullscreen" bottomStickOnMobile={false}>
        <DialogHeader>
          <div className="flex min-w-0 items-center gap-3 pe-8">
            <div className="min-w-0 flex-1">
              <DialogTitle>{props.title}</DialogTitle>
            </div>
            <div className="flex items-center gap-1">
              <Button
                aria-label="Zoom out"
                size="icon-sm"
                variant="ghost"
                disabled={zoom === 0.5}
                onClick={() => setZoom((value) => value - 0.25)}
              >
                <MinusIcon />
              </Button>
              <Button aria-label="Reset zoom" size="sm" variant="ghost" onClick={() => setZoom(1)}>
                {Math.round(zoom * 100)}%
              </Button>
              <Button
                aria-label="Zoom in"
                size="icon-sm"
                variant="ghost"
                disabled={zoom === 2}
                onClick={() => setZoom((value) => value + 0.25)}
              >
                <PlusIcon />
              </Button>
            </div>
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto [container-type:size]">
          <div className="h-[100cqh] w-[100cqw]" style={{ zoom }}>
            <HtmlRenderDocument src={props.src} title={props.title} className="block size-full" />
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
