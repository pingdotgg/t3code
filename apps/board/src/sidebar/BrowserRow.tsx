import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Globe } from "lucide-react";
import { useContext } from "react";

import { panelAtom, togglePanel } from "../browser/panel";
import { SidebarRow } from "./SidebarRow";

/** Shows or hides the browser panel beside the board. */
export function BrowserRow() {
  const registry = useContext(RegistryContext);
  const { open } = useAtomValue(panelAtom);
  return (
    <SidebarRow
      icon={<Globe className="size-3.5" />}
      title="Browser"
      selected={open}
      onClick={() => {
        if (!open) performance.mark("board:browser-click");
        togglePanel(registry);
      }}
    />
  );
}
