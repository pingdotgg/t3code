import { PaintbrushIcon } from "lucide-react";
import * as Equal from "effect/Equal";
import { DEFAULT_APPEARANCE_SETTINGS, type AppearanceSettings } from "@t3tools/contracts";
import { getAppearanceThemes, resolveAppearanceTheme } from "@t3tools/shared/appearance";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

export function hasAppearanceChanges(appearance: AppearanceSettings): boolean {
  return !Equal.equals(appearance, DEFAULT_APPEARANCE_SETTINGS);
}

export function getAppearanceChangedSettingLabels(appearance: AppearanceSettings): string[] {
  return hasAppearanceChanges(appearance) ? ["Theme"] : [];
}

export function AppearanceSettingsSection() {
  const appearance = useSettings((settings) => settings.appearance);
  const { updateSettings } = useUpdateSettings();
  const selectedTheme = resolveAppearanceTheme(appearance);
  const themes = getAppearanceThemes();

  return (
    <SettingsRow
      title="Theme"
      description="Choose the app color theme."
      resetAction={
        hasAppearanceChanges(appearance) ? (
          <SettingResetButton
            label="theme"
            onClick={() => updateSettings({ appearance: DEFAULT_APPEARANCE_SETTINGS })}
          />
        ) : null
      }
      control={
        <Select
          value={selectedTheme.id}
          onValueChange={(themeId) => {
            if (themeId) {
              updateSettings({ appearance: { ...appearance, themeId } });
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-64" aria-label="Theme">
            <SelectValue>{selectedTheme.name}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {themes.map((theme) => (
              <SelectItem hideIndicator key={theme.id} value={theme.id}>
                <span className="flex items-center gap-2">
                  <PaintbrushIcon className="size-3.5 text-muted-foreground/70" />
                  <span>{theme.name}</span>
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
