import type { StorageCleanupSettings, WorktreeCleanupRules } from "@t3tools/contracts";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

export function WorktreeIntegrationRows({
  settings,
  ruleStatus,
  serverScoped,
  updateWorktree,
}: {
  settings: WorktreeCleanupRules;
  ruleStatus: (key: keyof StorageCleanupSettings) => string | undefined;
  serverScoped: boolean;
  updateWorktree: (patch: Partial<WorktreeCleanupRules>) => void;
}) {
  const { connectedEnvironments } = useSettingsScope();
  return (
    <>
      <SettingsRow
        title="Delete unchanged worktrees"
        status={ruleStatus("worktreeUnchanged")}
        description="Remove worktrees with no commits beyond the default branch."
        serverScoped={serverScoped}
        control={
          <Switch
            aria-label="Delete unchanged worktrees"
            checked={settings.worktreeUnchanged}
            onCheckedChange={(worktreeUnchanged) => updateWorktree({ worktreeUnchanged })}
          />
        }
      />
      {connectedEnvironments.length > 0 &&
        connectedEnvironments.every(
          (environment) =>
            environment.serverConfig?.environment.capabilities.worktreeRequireIntegrated === true,
        ) && (
          <SettingsRow
            title="Only delete landed worktrees"
            status={ruleStatus("worktreeRequireIntegrated")}
            description="Every cleanup rule also requires the branch to be in the default branch or its pull request to be merged at the current commit."
            serverScoped={serverScoped}
            control={
              <Switch
                aria-label="Only delete landed worktrees"
                checked={settings.worktreeRequireIntegrated}
                onCheckedChange={(worktreeRequireIntegrated) =>
                  updateWorktree({ worktreeRequireIntegrated })
                }
              />
            }
          />
        )}
    </>
  );
}
