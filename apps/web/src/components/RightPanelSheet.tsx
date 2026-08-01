import { type ReactNode } from "react";

import { RIGHT_PANEL_SHEET_CLASS_NAME } from "../rightPanelLayout";
import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  onOpenChangeComplete: (open: boolean) => void;
}) {
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
      onOpenChangeComplete={props.onOpenChangeComplete}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className={RIGHT_PANEL_SHEET_CLASS_NAME}
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
