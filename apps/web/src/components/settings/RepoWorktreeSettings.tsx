import { useRef } from "react";

import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function RepoWorktreeSettings() {
  const settings = useScopedSettings();
  const { scope, targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const updateSettings = useUpdateScopedSettings();
  const instructionsEdited = useRef(false);
  const enabledMixed = useScopedSettingsMixed(["repoWorktrees"]);
  const instructionsMixed = useScopedSettingsMixed(["repoWorktreeInstructions"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["repoWorktrees"]}
        mixed={enabledMixed}
        {...searchableSetting("repo-worktrees")}
        description={
          isProjectScope
            ? "For a folder of several Git repositories. The thread stays in the folder, and agents create or reuse a worktree for each repository the work needs."
            : "For project folders that hold several Git repositories. Turn it on for those projects."
        }
        resetAction={
          settings.repoWorktrees ? (
            <SettingResetButton
              label="repository worktrees"
              tooltip="Turn repository worktrees off"
              onClick={() => updateSettings({ repoWorktrees: false })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Repository worktrees"
            mixed={enabledMixed}
            checked={enabledMixed ? false : settings.repoWorktrees}
            onCheckedChange={(enabled) => updateSettings({ repoWorktrees: enabled })}
          />
        }
      />
      {enabledMixed || settings.repoWorktrees ? (
        <SettingsRow
          serverScoped
          settingKeys={["repoWorktreeInstructions"]}
          title="Repository worktree guidance"
          description="Given to agents with the repository worktree rules, for example which branch each repository's work starts from."
          resetAction={
            instructionsMixed || settings.repoWorktreeInstructions !== "" ? (
              <SettingResetButton
                label="repository worktree guidance"
                onClick={() => updateSettings({ repoWorktreeInstructions: "" })}
              />
            ) : null
          }
        >
          <div className="mt-3 max-w-2xl pb-3.5">
            <Textarea
              key={`${scopeKey}:${instructionsMixed}:${settings.repoWorktreeInstructions}`}
              aria-label="Repository worktree guidance"
              onChange={() => {
                instructionsEdited.current = true;
              }}
              rows={4}
              defaultValue={instructionsMixed ? "" : settings.repoWorktreeInstructions}
              placeholder={
                instructionsMixed
                  ? "Mixed. Enter guidance to apply to all selected targets."
                  : "Start api work from develop. Start shared/framework work from team-develop."
              }
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (
                  instructionsEdited.current &&
                  (instructionsMixed || value !== settings.repoWorktreeInstructions)
                )
                  updateSettings({ repoWorktreeInstructions: value });
                instructionsEdited.current = false;
              }}
            />
          </div>
        </SettingsRow>
      ) : null}
    </>
  );
}
