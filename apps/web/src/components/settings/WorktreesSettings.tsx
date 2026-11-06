import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
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
import { searchableSetting } from "./settingsSearch";
import { WorktreeCleanupSection, WorktreesDirectoryRow } from "./StorageSettings";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const FORK_WORKSPACE_ITEMS = {
  inherit: "Use new thread setting",
  same: "Reuse original thread's workspace",
  worktree: "Create a new worktree",
};

function ForkWorkspaceRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["forkThreadEnvMode"]);
  return (
    <SettingsRow
      serverScoped
      settingKeys={["forkThreadEnvMode"]}
      {...searchableSetting("fork-workspace")}
      description="Choose whether forked threads reuse the original workspace or create a new worktree. Side chats always use the parent thread's workspace."
      resetAction={
        mixed || settings.forkThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.forkThreadEnvMode ? (
          <SettingResetButton
            label="workspace for forked threads"
            onClick={() =>
              updateSettings({ forkThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.forkThreadEnvMode })
            }
          />
        ) : null
      }
      control={
        <Select
          items={FORK_WORKSPACE_ITEMS}
          value={mixed ? null : settings.forkThreadEnvMode}
          onValueChange={(value) => {
            if (value === "inherit" || value === "same" || value === "worktree")
              updateSettings({ forkThreadEnvMode: value });
          }}
        >
          <SelectTrigger size="sm" aria-label="Workspace for forked threads">
            <SelectValue placeholder="Mixed" />
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(FORK_WORKSPACE_ITEMS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

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

export function WorktreesSettingsPanel() {
  const { scope } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  return (
    <SettingsPageContainer>
      <SettingsSection id="worktree-creation" title="Creation">
        {!isProjectScope && <WorktreesDirectoryRow />}
        {!isProjectScope && <ForkWorkspaceRow />}
        <StartFromRemoteRow />
        <AdvancedSettings targetIds={[searchableSetting("worktree-submodules").id]}>
          <WorktreeSubmodulesRow />
        </AdvancedSettings>
      </SettingsSection>
      <SettingsSection id="worktree-branches" title="Branches">
        <BranchNamingSettings />
      </SettingsSection>
      <WorktreeCleanupSection />
    </SettingsPageContainer>
  );
}
