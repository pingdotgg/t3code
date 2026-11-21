import { type CommandDisplayMode, DEFAULT_UNIFIED_SETTINGS } from "@lathe/contracts/settings";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const MODE_LABELS: Record<CommandDisplayMode, string> = {
  collapsed: "Collapsed",
  exposed: "Exposed",
};
const MODES = Object.keys(MODE_LABELS) as CommandDisplayMode[];

/** Fork setting: whether commands show their terminal output open in the chat. */
export function CommandDisplaySettings() {
  const mode = useScopedSettings((settings) => settings.commandDisplayMode);
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsRow
      {...searchableSetting("command-display")}
      description="Exposed shows every command's terminal output in the chat. Collapsed keeps it behind a click and opens only failed commands."
      resetAction={
        mode !== DEFAULT_UNIFIED_SETTINGS.commandDisplayMode ? (
          <SettingResetButton
            ariaLabel="Reset command display to default"
            onClick={() =>
              updateSettings({ commandDisplayMode: DEFAULT_UNIFIED_SETTINGS.commandDisplayMode })
            }
          />
        ) : null
      }
      control={
        <Select
          value={mode}
          onValueChange={(value) => {
            const next = MODES.find((candidate) => candidate === value);
            if (next) updateSettings({ commandDisplayMode: next });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Command display">
            <SelectValue>{MODE_LABELS[mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {MODES.map((candidate) => (
              <SelectItem key={candidate} hideIndicator value={candidate}>
                {MODE_LABELS[candidate]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
