// Fork: options for Kaluwa's folder tree: how a project shows its machine, how sub-agents
// nest under their thread, and how a parent marks a child that needs the user.
import type {
  KaluwaSidebarChildAttention,
  KaluwaSidebarFinishedSubagents,
  KaluwaSidebarMachineIndicator,
  KaluwaSidebarSubagents,
} from "@t3tools/contracts/settings";
import { msg, useGT, useMessages } from "gt-react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const MACHINE_INDICATOR_LABELS: Record<KaluwaSidebarMachineIndicator, string> = {
  "glyph-name": msg("Glyph and name"),
  glyph: msg("Glyph only"),
  edge: msg("Coloured edge"),
  off: msg("Off"),
};

const SUBAGENT_LABELS: Record<KaluwaSidebarSubagents, string> = {
  tree: msg("Nested tree"),
  chip: msg("Count chip"),
  off: msg("Off"),
};

const FINISHED_SUBAGENT_LABELS: Record<KaluwaSidebarFinishedSubagents, string> = {
  hide: msg("Hide"),
  show: msg("Show"),
};

const CHILD_ATTENTION_LABELS: Record<KaluwaSidebarChildAttention, string> = {
  marker: msg("Marker"),
  label: msg("Marker and label"),
  off: msg("Off"),
};

function OptionSelect<Value extends string>(props: {
  readonly value: Value;
  readonly labels: Record<Value, string>;
  readonly ariaLabel: string;
  readonly onChange: (value: Value) => void;
}) {
  const m = useMessages();
  const values = Object.keys(props.labels) as Value[];
  return (
    <Select
      value={props.value}
      onValueChange={(value) => {
        if (value !== null) props.onChange(value);
      }}
    >
      <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={props.ariaLabel}>
        <SelectValue>{(value: Value) => m(props.labels[value])}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {values.map((value) => (
          <SelectItem key={value} hideIndicator value={value}>
            {m(props.labels[value])}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** Applies to the project-folder sidebar (Labs › Boring sidebar). */
export function KaluwaSidebarSettings() {
  const gt = useGT();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsSection id="kaluwa-sidebar" title={gt("Sidebar: agents and machines")}>
      <SettingsRow
        devicePreference
        title={gt("Machine indicator")}
        description={gt(
          "How a project folder shows the machine it lives on. Hidden while this is your only machine; hover it for the system and connection.",
        )}
        control={
          <OptionSelect
            value={settings.kaluwaSidebarMachineIndicator}
            labels={MACHINE_INDICATOR_LABELS}
            ariaLabel={gt("Machine indicator")}
            onChange={(value) => updateSettings({ kaluwaSidebarMachineIndicator: value })}
          />
        }
      />
      <SettingsRow
        devicePreference
        title={gt("Sub-agents")}
        description={gt(
          "Show a thread's sub-agents under it in its folder. The count beside a thread folds them.",
        )}
        control={
          <OptionSelect
            value={settings.kaluwaSidebarSubagents}
            labels={SUBAGENT_LABELS}
            ariaLabel={gt("Sub-agents")}
            onChange={(value) => updateSettings({ kaluwaSidebarSubagents: value })}
          />
        }
      />
      <SettingsRow
        devicePreference
        title={gt("Finished sub-agents")}
        description={gt(
          "Hide sub-agents once their work is done, so the tree lists only what is still running or needs you. A failure stays until you open it. Right-click a thread to show its finished ones.",
        )}
        control={
          <OptionSelect
            value={settings.kaluwaSidebarFinishedSubagents}
            labels={FINISHED_SUBAGENT_LABELS}
            ariaLabel={gt("Finished sub-agents")}
            onChange={(value) => updateSettings({ kaluwaSidebarFinishedSubagents: value })}
          />
        }
      />
      <SettingsRow
        devicePreference
        title={gt("Child needs you")}
        description={gt(
          "Mark a thread's avatar when one of its sub-agents needs your approval or input, or failed. The thread keeps its own status.",
        )}
        control={
          <OptionSelect
            value={settings.kaluwaSidebarChildAttention}
            labels={CHILD_ATTENTION_LABELS}
            ariaLabel={gt("Child needs you")}
            onChange={(value) => updateSettings({ kaluwaSidebarChildAttention: value })}
          />
        }
      />
    </SettingsSection>
  );
}
