import { msg, useMessages } from "gt-react";
import { useRef } from "react";
import { BranchNamingMode, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const MODES = {
  static: msg("Static prefix"),
  semantic: msg("Semantic prefix"),
  custom: msg("Custom instructions"),
} satisfies Record<BranchNamingMode, string>;

export function BranchNamingSettings() {
  const m = useMessages();
  const settings = useScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const prefixEdited = useRef(false);
  const instructionsEdited = useRef(false);
  const updateSettings = useUpdateScopedSettings();
  const modeMixed = useScopedSettingsMixed(["branchNamingMode"]);
  const prefixMixed = useScopedSettingsMixed(["branchNamePrefix"]);
  const instructionsMixed = useScopedSettingsMixed(["branchNameInstructions"]);

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["branchNamingMode"]}
        {...searchableSetting("worktree-branch-naming")}
        description={msg("Choose how new worktree branches are named from your first message.")}
        status={
          !modeMixed && settings.branchNamingMode === "semantic"
            ? m(
                msg(
                  "The model chooses a prefix that describes the work, such as feat/add-search, fix/login-timeout, or refactor/auth.",
                ),
              )
            : undefined
        }
        resetAction={
          settings.branchNamingMode !== DEFAULT_SERVER_SETTINGS.branchNamingMode || modeMixed ? (
            <SettingResetButton
              label={m(msg("branch naming"))}
              onClick={() =>
                updateSettings({ branchNamingMode: DEFAULT_SERVER_SETTINGS.branchNamingMode })
              }
            />
          ) : null
        }
        control={
          <Select
            value={modeMixed ? null : settings.branchNamingMode}
            onValueChange={(value) => {
              if (BranchNamingMode.literals.includes(value as BranchNamingMode)) {
                updateSettings({ branchNamingMode: value as BranchNamingMode });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label={m(msg("Worktree branch naming"))}>
              <SelectValue>
                {(value: BranchNamingMode | null) =>
                  value === null ? m(msg("Mixed")) : m(MODES[value])
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {BranchNamingMode.literals.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {m(MODES[mode])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {!modeMixed && settings.branchNamingMode === "static" ? (
        <SettingsRow
          serverScoped
          settingKeys={["branchNamePrefix"]}
          title={msg("Branch prefix")}
          description={msg(
            "For example, t3 or t3/ produces t3/add-search. Leave empty for no prefix.",
          )}
          resetAction={
            prefixMixed ||
            settings.branchNamePrefix !== DEFAULT_SERVER_SETTINGS.branchNamePrefix ? (
              <SettingResetButton
                label={m(msg("branch prefix"))}
                onClick={() =>
                  updateSettings({ branchNamePrefix: DEFAULT_SERVER_SETTINGS.branchNamePrefix })
                }
              />
            ) : null
          }
          control={
            <Input
              key={`${scopeKey}:${prefixMixed}:${settings.branchNamePrefix}`}
              aria-label={m(msg("Branch prefix"))}
              autoCapitalize="none"
              spellCheck={false}
              onChange={() => {
                prefixEdited.current = true;
              }}
              placeholder={prefixMixed ? m(msg("Mixed")) : m(msg("No prefix"))}
              defaultValue={prefixMixed ? "" : settings.branchNamePrefix}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (prefixEdited.current && (prefixMixed || value !== settings.branchNamePrefix))
                  updateSettings({ branchNamePrefix: value });
                prefixEdited.current = false;
              }}
            />
          }
        />
      ) : null}
      {!modeMixed && settings.branchNamingMode === "custom" ? (
        <SettingsRow
          serverScoped
          settingKeys={["branchNameInstructions"]}
          title={msg("Branch naming instructions")}
          description={msg(
            "Appended to the naming prompt. The model returns the complete branch name; no prefix or suffix is added.",
          )}
          resetAction={
            instructionsMixed || settings.branchNameInstructions !== "" ? (
              <SettingResetButton
                label={m(msg("branch naming instructions"))}
                onClick={() => updateSettings({ branchNameInstructions: "" })}
              />
            ) : null
          }
        >
          <div className="mt-3 max-w-2xl pb-3.5">
            <Textarea
              key={`${scopeKey}:${instructionsMixed}:${settings.branchNameInstructions}`}
              aria-label={m(msg("Branch naming instructions"))}
              onChange={() => {
                instructionsEdited.current = true;
              }}
              rows={4}
              defaultValue={instructionsMixed ? "" : settings.branchNameInstructions}
              placeholder={
                instructionsMixed
                  ? m(msg("Mixed. Enter instructions to apply to all selected targets."))
                  : m(msg("Use julius/ followed by the issue ID and a short description."))
              }
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (
                  instructionsEdited.current &&
                  (instructionsMixed || value !== settings.branchNameInstructions)
                )
                  updateSettings({ branchNameInstructions: value });
                instructionsEdited.current = false;
              }}
            />
          </div>
        </SettingsRow>
      ) : null}
    </>
  );
}
