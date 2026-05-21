import { type ReactNode } from "react";

import { RIGHT_PANEL_SHEET_CLASS_NAME } from "../rightPanelLayout";
import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet
      modal={false}
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        allowOutsidePointerEvents
        data-right-panel-sheet="true"
        side="right"
        showCloseButton={false}
        showBackdrop={false}
        keepMounted
        className={RIGHT_PANEL_SHEET_CLASS_NAME}
      >
        <div className="flex h-full min-h-0 w-full flex-col max-[760px]:pb-safe max-[760px]:pr-safe max-[760px]:pt-safe">
          {props.children}
        </div>
      </SheetPopup>
    </Sheet>
  );
}
