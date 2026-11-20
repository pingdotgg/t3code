import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Files, type LucideIcon, MessageSquare } from "lucide-react";
import { useContext } from "react";

import { Tooltip } from "../ui/Tooltip";
import { type PanelTab, panelAtom, setPanelTab } from "./panel";

const TABS = [
  { id: "chat", label: "Orchestrator", hint: "Orchestrator", icon: MessageSquare },
  { id: "explorer", label: "Explorer", hint: "Explorer (Ctrl+⇧+E)", icon: Files },
] as const satisfies ReadonlyArray<{
  id: PanelTab;
  label: string;
  hint: string;
  icon: LucideIcon;
}>;

/**
 * The panel's tabs as Orca's right sidebar draws them: icons only, 36px apart, with a short
 * underline under the active one. The top bar's toggle closes the panel, as Orca's does.
 */
export function PanelTabs() {
  const registry = useContext(RegistryContext);
  const active = useAtomValue(panelAtom).tab;
  return (
    <div
      role="tablist"
      aria-label="Panel tabs"
      className="flex shrink-0 items-center border-b border-line px-1.5"
    >
      {TABS.map(({ id, label, hint, icon: Icon }) => (
        <Tooltip key={id} text={hint} side="bottom" align="center">
          <button
            type="button"
            role="tab"
            id={`panel-tab-${id}`}
            aria-selected={id === active}
            aria-controls={`panel-${id}`}
            aria-label={label}
            onClick={() => setPanelTab(registry, id)}
            className={`relative grid h-9 w-9 place-items-center ${id === active ? "text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-fg" : "text-faint hover:text-muted"}`}
          >
            <Icon className="size-4" aria-hidden />
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
