import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { PanelRight } from "lucide-react";
import { useContext } from "react";

import { appAtomRegistry } from "../state/registry";
import { Tooltip } from "../ui/Tooltip";
import { panelAtom, showPanelTab, togglePanel } from "./panel";
import { iconButton } from "./styles";

// Orca's shortcut for its explorer, which the tab's tooltip names. A stable function, so a re-render does not subscribe again.
function listenForExplorerShortcut(node: HTMLElement | null) {
  if (node === null) return;
  const onKey = (event: KeyboardEvent) => {
    if (!event.ctrlKey || !event.shiftKey || event.code !== "KeyE") return;
    event.preventDefault();
    showPanelTab(appAtomRegistry, "explorer");
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

/** The top bar's button for the right sidebar, where Orca puts its own, left of the window controls. */
export function PanelToggle() {
  const registry = useContext(RegistryContext);
  const { open } = useAtomValue(panelAtom);
  return (
    // The window controls draw over the right edge of the top bar, so the button stops short of them.
    <div
      ref={listenForExplorerShortcut}
      style={{
        marginRight: "calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))",
      }}
    >
      <Tooltip
        text={open ? "Hide the right sidebar" : "Show the right sidebar"}
        side="bottom"
        align="end"
      >
        <button
          type="button"
          aria-label="Toggle the right sidebar"
          aria-pressed={open}
          onClick={() => togglePanel(registry)}
          className={iconButton}
        >
          <PanelRight className="size-4" aria-hidden />
        </button>
      </Tooltip>
    </div>
  );
}
