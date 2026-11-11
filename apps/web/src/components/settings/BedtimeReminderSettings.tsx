import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function BedtimeReminderSettings() {
  const time = useScopedSettings((settings) => settings.bedtimeReminderTime);
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("bedtime-reminder")}
      description="After this time every night, a full-screen reminder tells you to go to sleep. Leave empty to turn it off."
      settingKeys={["bedtimeReminderTime"]}
      control={
        <Input
          type="time"
          className="w-28"
          value={time ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            updateSettings({
              bedtimeReminderTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null,
            });
          }}
          aria-label="Bedtime"
        />
      }
    />
  );
}
