import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Globe } from "lucide-react";
import { useContext } from "react";

import { showBrowser } from "../browser/browserTabs";
import { filesViewAtom } from "../state/filesView";
import { SidebarRow } from "./SidebarRow";

/** Shows the browser as a tab of the main view, beside the board. */
export function BrowserRow() {
  const registry = useContext(RegistryContext);
  const showing = useAtomValue(filesViewAtom).surface !== null;
  return (
    <SidebarRow
      icon={<Globe className="size-3.5" />}
      title="Browser"
      selected={showing}
      onClick={() => {
        if (!showing) performance.mark("board:browser-click");
        showBrowser(registry);
      }}
    />
  );
}
