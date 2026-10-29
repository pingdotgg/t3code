import { type ReactNode, type Ref } from "react";

import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet({
  animationDurationMs,
  children,
  open,
  onClose,
  sheetRef,
}: {
  animationDurationMs: number;
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  sheetRef?: Ref<HTMLDivElement> | undefined;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetPopup
        ref={sheetRef}
        transitionDurationMs={animationDurationMs}
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(42vw,28rem)] min-w-80 max-w-[28rem] max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 wco:mt-(--workspace-topbar-height) wco:h-[calc(100%-var(--workspace-topbar-height))] wco:max-h-[calc(100%-var(--workspace-topbar-height))]"
      >
        {children}
      </SheetPopup>
    </Sheet>
  );
}
