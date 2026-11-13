import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
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

function BaseBranchRow() {
  const settings = useScopedSettings();
  const { scope, target } = useSettingsScope();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["newWorktreesBaseBranch"]);
  const member =
    (scope.kind === "project" || scope.kind === "checkout") && target?.projectId
      ? scope.members.find(
          (candidate) =>
            candidate.id === target.projectId && candidate.environmentId === target.environmentId,
        )
      : undefined;
  return (
    <SettingsRow
      serverScoped
      settingKeys={["newWorktreesBaseBranch"]}
      {...searchableSetting("worktree-base-branch")}
      description="The branch new worktrees start from, such as dev. You can still pick another branch for each thread."
      resetAction={
        mixed || settings.newWorktreesBaseBranch !== "" ? (
          <SettingResetButton
            label="base branch"
            onClick={() => updateSettings({ newWorktreesBaseBranch: "" })}
          />
        ) : null
      }
      control={
        <div className="w-48">
          <WorktreeBaseBranchPicker
            key={`${member?.environmentId}:${member?.workspaceRoot}`}
            aria-label="Base branch for new worktrees"
            environmentId={member?.environmentId ?? null}
            cwd={member?.workspaceRoot ?? null}
            value={mixed ? "" : settings.newWorktreesBaseBranch}
            emptyLabel={mixed ? "Mixed" : "Repository default"}
            onValueChange={(newWorktreesBaseBranch) => updateSettings({ newWorktreesBaseBranch })}
            startFromOrigin={settings.newWorktreesStartFromOrigin}
            defaultOption={{ label: "Repository default" }}
            allowCustomRef
          />
        </div>
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
        <BaseBranchRow />
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
