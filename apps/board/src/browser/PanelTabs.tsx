import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Files, Globe, type LucideIcon, X } from "lucide-react";
import { useContext } from "react";

import { Tooltip } from "../ui/Tooltip";
import { closePanel, type PanelTab, panelAtom, setPanelTab } from "./panel";
import { iconButton } from "./styles";

const TABS = [
  { id: "files", label: "Files", icon: Files },
  { id: "browser", label: "Browser", icon: Globe },
] as const satisfies ReadonlyArray<{ id: PanelTab; label: string; icon: LucideIcon }>;

/** The panel's tabs as icons with an underline under the active one, the way Orca's right sidebar draws them. */
export function PanelTabs() {
  const registry = useContext(RegistryContext);
  const active = useAtomValue(panelAtom).tab;
  return (
    <div className="flex items-center justify-between border-b border-line px-2">
      <div role="tablist" aria-label="Panel tabs" className="flex items-center">
        {TABS.map(({ id, label, icon: Icon }) => (
          <Tooltip key={id} text={label} side="bottom">
            <button
              type="button"
              role="tab"
              id={`panel-tab-${id}`}
              aria-selected={id === active}
              aria-controls={`panel-${id}`}
              aria-label={label}
              onClick={() => setPanelTab(registry, id)}
              className={`relative grid h-9 w-10 place-items-center ${id === active ? "text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-fg" : "text-muted hover:text-fg"}`}
            >
              <Icon className="size-4" aria-hidden />
            </button>
          </Tooltip>
        ))}
      </div>
      <Tooltip text="Close the panel" side="bottom" align="end">
        <button
          type="button"
          aria-label="Close the panel"
          onClick={() => closePanel(registry)}
          className={iconButton}
        >
          <X className="size-4" />
        </button>
      </Tooltip>
    </div>
  );
}
