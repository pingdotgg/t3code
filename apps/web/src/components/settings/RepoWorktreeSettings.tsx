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
            ? "Create or reuse separate worktrees for the Git repositories inside this project folder as needed."
            : "Create or reuse separate worktrees for the Git repositories inside each project folder as needed. Projects can override it."
        }
        resetAction={
          settings.repoWorktrees ? (
            <SettingResetButton
              label="multi-repository project folder"
              tooltip="Reset multi-repository project folder to off"
              onClick={() => updateSettings({ repoWorktrees: false })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Multi-Repository Project Folder"
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
          title="Repository Guidance"
          description="Instructions for agents working in these repositories, such as base branches and submodule rules."
          resetAction={
            instructionsMixed || settings.repoWorktreeInstructions !== "" ? (
              <SettingResetButton
                label="repository guidance"
                onClick={() => updateSettings({ repoWorktreeInstructions: "" })}
              />
            ) : null
          }
        >
          <div className="mt-3 max-w-2xl pb-3.5">
            <Textarea
              key={`${scopeKey}:${instructionsMixed}:${settings.repoWorktreeInstructions}`}
              aria-label="Repository Guidance"
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
