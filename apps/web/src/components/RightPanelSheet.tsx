import { type ReactNode, use } from "react";

import { ChatPaneContext } from "./chat/chatPane";
import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  animationDurationMs: number;
  children: ReactNode;
  open: boolean;
  onClose: () => void;
}) {
  // In a split, the sheet covers its own pane rather than the window.
  const paneElement = use(ChatPaneContext)?.element ?? undefined;
  return (
    <Sheet
      open={props.open}
      // A modal sheet would also lock the other pane.
      modal={paneElement === undefined}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        transitionDurationMs={props.animationDurationMs}
        side="right"
        showCloseButton={false}
        keepMounted
        portalContainer={paneElement}
        className="w-[min(42vw,28rem)] min-w-80 max-w-[min(28rem,100%)] max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 wco:mt-(--workspace-topbar-height) wco:h-[calc(100%-var(--workspace-topbar-height))] wco:max-h-[calc(100%-var(--workspace-topbar-height))]"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
