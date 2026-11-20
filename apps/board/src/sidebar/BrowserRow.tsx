import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Globe } from "lucide-react";
import { useContext } from "react";

import { panelAtom, togglePanelTab } from "../browser/panel";
import { SidebarRow } from "./SidebarRow";

/** Shows or hides the browser panel beside the board. */
export function BrowserRow() {
  const registry = useContext(RegistryContext);
  const { open, tab } = useAtomValue(panelAtom);
  const showing = open && tab === "browser";
  return (
    <SidebarRow
      icon={<Globe className="size-3.5" />}
      title="Browser"
      selected={showing}
      onClick={() => {
        if (!showing) performance.mark("board:browser-click");
        togglePanelTab(registry, "browser");
      }}
    />
  );
}
