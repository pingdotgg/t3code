import { RegistryContext } from "@effect/atom-react";
import { Plus, X } from "lucide-react";
import { useContext } from "react";

import { Tooltip } from "../ui/Tooltip";
import { closeTab, dispatchTabs, openTab } from "./panel";
import { iconButton } from "./styles";
import type { Tab } from "./tabs";

const labelOf = (tab: Tab): string => {
  if (tab.title !== "") return tab.title;
  try {
    return new URL(tab.url).host || "New tab";
  } catch {
    return "New tab";
  }
};

/** The user's open tabs, each with a close button, and the button that opens a blank one. */
export function TabStrip({
  tabs,
  activeId,
}: {
  tabs: ReadonlyArray<Tab>;
  activeId: string | null;
}) {
  const registry = useContext(RegistryContext);
  return (
    <div
      role="tablist"
      aria-label="Browser tabs"
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
    >
      {tabs.map((tab) => (
        <div
          key={tab.id}
          data-testid="browser-tab"
          data-active={tab.id === activeId}
          className={`flex max-w-40 min-w-14 items-center rounded-md ${tab.id === activeId ? "bg-hover text-fg" : "text-muted hover:bg-hover"}`}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab.id === activeId}
            onClick={() => dispatchTabs(registry, { type: "activate", id: tab.id })}
            className="min-w-0 flex-1 truncate py-1 pl-2 text-left text-[12px]"
          >
            {labelOf(tab)}
          </button>
          <button
            type="button"
            aria-label={`Close ${labelOf(tab)}`}
            onClick={() => closeTab(registry, tab.id)}
            className="grid size-5 shrink-0 place-items-center rounded-sm hover:text-fg"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      <Tooltip text="New tab" side="bottom">
        <button
          type="button"
          aria-label="New tab"
          onClick={() => openTab(registry, "")}
          className={iconButton}
        >
          <Plus className="size-4" />
        </button>
      </Tooltip>
    </div>
  );
}
