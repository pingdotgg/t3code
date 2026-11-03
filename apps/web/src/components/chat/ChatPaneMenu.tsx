import { Columns2Icon, Rows2Icon } from "lucide-react";
import { use } from "react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ChatPaneContext } from "./chatPane";

/** Arranges the split from the header of either pane; renders nothing outside a split. */
export function ChatPaneMenu() {
  const chatPane = use(ChatPaneContext);
  if (chatPane === null) return null;
  const sideBySide = chatPane.direction === "row";
  const Icon = sideBySide ? Columns2Icon : Rows2Icon;
  return (
    <Menu>
      <MenuTrigger
        render={<Button aria-label="Split pane options" size="icon-xs" variant="ghost-muted" />}
      >
        <Icon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" sideOffset={6}>
        <MenuItem onClick={chatPane.swap}>Swap panes</MenuItem>
        <MenuItem onClick={() => chatPane.setDirection(sideBySide ? "column" : "row")}>
          {sideBySide ? "Stack top and bottom" : "Place side by side"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={chatPane.close}>Close pane</MenuItem>
      </MenuPopup>
    </Menu>
  );
}
