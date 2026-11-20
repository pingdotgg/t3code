import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Files } from "lucide-react";
import { useContext } from "react";

import { panelAtom, togglePanelTab } from "../browser/panel";
import { SidebarRow } from "./SidebarRow";

/** Shows or hides the files tab of the panel beside the board. */
export function FilesRow() {
  const registry = useContext(RegistryContext);
  const { open, tab } = useAtomValue(panelAtom);
  return (
    <SidebarRow
      icon={<Files className="size-3.5" />}
      title="Files"
      selected={open && tab === "files"}
      onClick={() => togglePanelTab(registry, "files")}
    />
  );
}
