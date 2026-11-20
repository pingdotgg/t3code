import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { PanelRight } from "lucide-react";
import { useContext } from "react";

import { Tooltip } from "../ui/Tooltip";
import { panelAtom, togglePanel } from "./panel";
import { iconButton } from "./styles";

/** The top bar's button for the right sidebar, where Orca puts its own, left of the window controls. */
export function PanelToggle() {
  const registry = useContext(RegistryContext);
  const { open } = useAtomValue(panelAtom);
  return (
    // The window controls draw over the right edge of the top bar, so the button stops short of them.
    <div
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
