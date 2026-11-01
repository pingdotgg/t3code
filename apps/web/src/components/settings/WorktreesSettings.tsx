import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { AdvancedSettings } from "./AdvancedSettings";
import { BranchNamingSettings } from "./BranchNamingSettings";
import { WorktreeSubmodulesRow } from "./ProjectDefaultsSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { searchableSetting } from "./settingsSearch";
import { WorktreeCleanupSection, WorktreesDirectoryRow } from "./StorageSettings";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function StartFromRemoteRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["newWorktreesStartFromOrigin"]}
      {...searchableSetting("start-from-origin")}
      description="Uses the latest commit of the base branch’s tracked remote branch, even if its name differs. Otherwise uses the same-named branch on origin. Uses your local branch if that remote branch is missing."
      resetAction={
        settings.newWorktreesStartFromOrigin !==
        DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
          <SettingResetButton
            label="new worktrees start from remote"
            onClick={() =>
              updateSettings({
                newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["newWorktreesStartFromOrigin"]}
          checked={settings.newWorktreesStartFromOrigin}
          onCheckedChange={(checked) =>
            updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
          }
          aria-label="Start new worktrees from remote by default"
        />
      }
    />
  );
}

const WORKTREE_FAST_INSTALL_COMMAND =
  "cargo install --locked --git https://github.com/mweinbach/worktree-fast.git git-worktree-fast";

function WorktreeFastRow() {
  const { connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  if (
    connectedEnvironments.length === 0 ||
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.worktreeFast === undefined,
    )
  )
    return null;
  const missing = connectedEnvironments.filter(
    (environment) =>
      environment.serverConfig?.environment.capabilities.worktreeFast?.installed !== true,
  );

  return (
    <SettingsRow
      serverScoped
      settingKeys={["enableWorktreeFast"]}
      {...searchableSetting("worktree-fast")}
      description={
        missing.length === 0 ? (
          "Clones commits you prepared with git-worktree-fast from its APFS cache instead of checking them out. Other commits, and any failure, use Git’s normal checkout."
        ) : (
          <span className="block space-y-1">
            <span className="block">
              {connectedEnvironments.length === 1
                ? "Install git-worktree-fast to use this, then reload:"
                : `Install git-worktree-fast on ${missing
                    .map((environment) =>
                      settingsScopeEnvironmentLabel(environment, connectedEnvironments),
                    )
                    .join(", ")} to use this, then reload:`}
            </span>
            <code className="block select-text wrap-anywhere">{WORKTREE_FAST_INSTALL_COMMAND}</code>
          </span>
        )
      }
      resetAction={
        settings.enableWorktreeFast !== DEFAULT_UNIFIED_SETTINGS.enableWorktreeFast ? (
          <SettingResetButton
            label="git-worktree-fast"
            onClick={() =>
              updateSettings({ enableWorktreeFast: DEFAULT_UNIFIED_SETTINGS.enableWorktreeFast })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["enableWorktreeFast"]}
          checked={settings.enableWorktreeFast}
          disabled={missing.length > 0 && !settings.enableWorktreeFast}
          onCheckedChange={(checked) => updateSettings({ enableWorktreeFast: Boolean(checked) })}
          aria-label="Create worktrees with git-worktree-fast"
        />
      }
    />
  );
}

export function WorktreesSettingsPanel() {
  const { scope } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  return (
    <SettingsPageContainer>
      <SettingsSection id="worktree-creation" title="Creation">
        {!isProjectScope && <WorktreesDirectoryRow />}
        <StartFromRemoteRow />
        <AdvancedSettings
          targetIds={[
            searchableSetting("worktree-submodules").id,
            searchableSetting("worktree-fast").id,
          ]}
        >
          <WorktreeSubmodulesRow />
          {!isProjectScope && <WorktreeFastRow />}
        </AdvancedSettings>
      </SettingsSection>
      <SettingsSection id="worktree-branches" title="Branches">
        <BranchNamingSettings />
      </SettingsSection>
      <WorktreeCleanupSection />
    </SettingsPageContainer>
  );
}
