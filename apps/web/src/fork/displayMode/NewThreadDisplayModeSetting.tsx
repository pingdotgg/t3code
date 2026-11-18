import {
  DISPLAY_MODES,
  NORMAL_DISPLAY_MODE,
  resolveDisplayMode,
} from "@t3tools/shared/displayModes";

import { useSettingsScope } from "~/components/settings/SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "~/components/settings/settingsLayout";
import { useSearchableSetting } from "~/components/settings/settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "~/components/settings/useScopedSettings";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

export function NewThreadDisplayModeSetting() {
  const setting = useSearchableSetting();
  const { connectedEnvironments } = useSettingsScope();
  const mode = resolveDisplayMode(useScopedSettings((settings) => settings.newThreadDisplayMode));
  const mixed = useScopedSettingsMixed(["newThreadDisplayMode"]);
  const updateSettings = useUpdateScopedSettings();
  if (
    connectedEnvironments.length === 0 ||
    !connectedEnvironments.every(
      (environment) =>
        environment.serverConfig?.environment.capabilities.threadDisplayModes === true,
    )
  ) {
    return null;
  }

  return (
    <SettingsRow
      serverScoped
      settingKeys={["newThreadDisplayMode"]}
      {...setting("new-thread-display-mode")}
      description="Mode for threads you start from the message box in the web or desktop app. Threads that agents, schedules, side chats or the mobile app start open in Normal. Existing threads keep their mode."
      resetAction={
        mode.id !== NORMAL_DISPLAY_MODE.id ? (
          <SettingResetButton
            ariaLabel="Reset display mode to default"
            onClick={() => updateSettings({ newThreadDisplayMode: NORMAL_DISPLAY_MODE.id })}
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : mode.id}
          onValueChange={(value) => {
            const next = DISPLAY_MODES.find((candidate) => candidate.id === value);
            if (next !== undefined) updateSettings({ newThreadDisplayMode: next.id });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-48" aria-label="New thread display mode">
            <SelectValue>
              {(value: string | null) =>
                value === null ? "Mixed" : resolveDisplayMode(value).label
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {DISPLAY_MODES.map((candidate) => (
              <SelectItem hideIndicator key={candidate.id} value={candidate.id}>
                {candidate.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
