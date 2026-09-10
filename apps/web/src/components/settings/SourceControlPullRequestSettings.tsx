import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function SourceControlPullRequestSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const defaultValue = DEFAULT_UNIFIED_SETTINGS.createGitHubPullRequestsAsDraft;

  return (
    <SettingsSection title="Pull requests">
      <SettingsRow
        serverScoped
        {...searchableSetting("create-github-pull-requests-as-draft")}
        description="Start new GitHub pull requests as drafts. Mark them ready for review when you have finished iterating."
        resetAction={
          settings.createGitHubPullRequestsAsDraft !== defaultValue ? (
            <SettingResetButton
              label="draft pull requests"
              onClick={() => updateSettings({ createGitHubPullRequestsAsDraft: defaultValue })}
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.createGitHubPullRequestsAsDraft}
            onCheckedChange={(checked) =>
              updateSettings({ createGitHubPullRequestsAsDraft: Boolean(checked) })
            }
            aria-label="Create GitHub pull requests as drafts"
          />
        }
      />
    </SettingsSection>
  );
}
