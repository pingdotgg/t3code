import { useRef } from "react";
import {
  AGENT_ICON_CATEGORY_LABELS,
  AGENT_ICON_IDS,
  AGENT_ICONS,
  agentIconMatches,
  type AgentIconId,
} from "@t3tools/client-runtime/state/agentIdentity";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { Button } from "../ui/button";
import { AgentIcon } from "./AgentIcon";

/** A searchable listbox of the curated icons; search covers names, roles, and keywords. */
export function AgentIconPicker({
  value,
  onChange,
}: {
  value: AgentIconId;
  onChange: (iconId: AgentIconId) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <Combobox
      items={AGENT_ICON_IDS}
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
      itemToStringLabel={(id) => AGENT_ICONS[id].label}
      filter={(id, query) => agentIconMatches(id, query)}
    >
      <ComboboxTrigger
        ref={triggerRef}
        aria-label={`Icon: ${AGENT_ICONS[value].label}. Change icon`}
        render={<Button type="button" variant="outline" size="icon-lg" />}
      >
        <AgentIcon iconId={value} />
      </ComboboxTrigger>
      <ComboboxPopup anchor={triggerRef} className="w-72">
        <ComboboxSearchInput placeholder="Search icons…" aria-label="Search icons" />
        <ComboboxEmpty>No icons match.</ComboboxEmpty>
        <ComboboxList>
          {(id: AgentIconId) => (
            <ComboboxItem key={id} value={id}>
              <span className="agent-icon-option" aria-hidden="true">
                <AgentIcon iconId={id} size="sm" />
              </span>
              <span className="min-w-0 flex-1 truncate">{AGENT_ICONS[id].label}</span>
              <span className="text-xs text-muted-foreground">
                {AGENT_ICON_CATEGORY_LABELS[AGENT_ICONS[id].category]}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
