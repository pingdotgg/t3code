import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function BetaSettingsPanel() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedReviewGuidesEnabled = useScopedSettingsMixed(["reviewGuidesEnabled"]);

  return (
    <SettingsPageContainer>
      <SettingsSection id="beta" title="Beta features">
        <SettingsRow
          {...searchableSetting("boring-sidebar")}
          description="Group sidebar threads into project folders. Pinned and snoozed threads stay outside the folders."
          control={
            <Switch
              checked={settings.boringSidebarEnabled || settings.legacySidebarEnabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  boringSidebarEnabled: Boolean(checked),
                  legacySidebarEnabled: false,
                })
              }
              aria-label="Boring Sidebar (group by project)"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("working-shelf")}
          description="Fold working and monitoring threads into a Working section. They return to the top of the inbox when they need you. The boring sidebar has no Working section."
          control={
            <Switch
              checked={settings.sidebarWorkingShelfEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ sidebarWorkingShelfEnabled: Boolean(checked) })
              }
              aria-label="Working section"
            />
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["compactIdleThreads"]}
          {...searchableSetting("compact-idle-threads")}
          description="Compact long idle Claude threads just before their prompt cache expires, so coming back costs less."
          control={
            <ScopedSwitch
              settingKeys={["compactIdleThreads"]}
              checked={settings.compactIdleThreads}
              onCheckedChange={(checked) =>
                updateSettings({ compactIdleThreads: Boolean(checked) })
              }
              aria-label="Compact idle Claude threads"
            />
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["reviewGuidesEnabled"]}
          mixed={mixedReviewGuidesEnabled}
          {...searchableSetting("review-guides")}
          description="Adds a Guide tab to pull requests: an agent writes a tour of the change, stop by stop, with the calls a maintainer should make. Choose its model in Source Control."
          control={
            <Switch
              mixed={mixedReviewGuidesEnabled}
              checked={mixedReviewGuidesEnabled ? false : settings.reviewGuidesEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ reviewGuidesEnabled: Boolean(checked) })
              }
              aria-label="Review guides"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
