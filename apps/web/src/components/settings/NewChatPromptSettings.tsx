import { useEffect, useId, useRef } from "react";
import { isManagedSettingPath } from "@t3tools/contracts";

import { Textarea } from "../ui/textarea";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useClearScopedSettings,
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function NewChatPromptSettings() {
  const settings = useScopedSettings();
  const { targets, connectedEnvironments } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const edited = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draft = useRef<{ scopeKey: string; value: string } | null>(null);
  const updateSettings = useUpdateScopedSettings();
  const clearSettings = useClearScopedSettings();
  const mixed = useScopedSettingsMixed(["newChatPrompt"]);
  const enabledMixed = useScopedSettingsMixed(["newChatPromptEnabled"]);
  const canWrite = useScopedSettingsWriteAllowed();
  const promptPolicy = connectedEnvironments
    .map((environment) => environment.serverConfig?.managedPolicy)
    .find((policy) => isManagedSettingPath(policy, "newChatPrompt"));
  const policyDescriptionId = useId();
  const promptManaged = promptPolicy !== undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- syncs saved settings into the uncontrolled textarea while preserving newer edits
  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    const pending = draft.current;
    if (
      !promptManaged &&
      pending?.scopeKey === scopeKey &&
      pending.value !== settings.newChatPrompt
    )
      return;
    draft.current = null;
    edited.current = false;
    input.value = mixed ? "" : settings.newChatPrompt;
  }, [mixed, promptManaged, scopeKey, settings.newChatPrompt]);
  const pendingPromptPatch = () => {
    const pending = draft.current;
    return promptPolicy === undefined &&
      pending?.scopeKey === scopeKey &&
      inputRef.current?.value.trim() === pending.value
      ? { newChatPrompt: pending.value }
      : undefined;
  };

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["newChatPromptEnabled"]}
        onResetOverride={() => clearSettings(["newChatPromptEnabled"], pendingPromptPatch())}
        {...searchableSetting("new-chat-prompt")}
        description="Append saved instructions to your first message in each new chat. Off by default. Later messages and existing conversations are unchanged."
        resetAction={
          enabledMixed || settings.newChatPromptEnabled ? (
            <SettingResetButton
              label="new chat prompt"
              onClick={() =>
                updateSettings({ newChatPromptEnabled: false, ...pendingPromptPatch() })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["newChatPromptEnabled"]}
            checked={settings.newChatPromptEnabled}
            onCheckedChange={(checked) =>
              updateSettings({
                newChatPromptEnabled: Boolean(checked),
                ...pendingPromptPatch(),
              })
            }
            aria-label="Enable new chat prompt"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["newChatPrompt"]}
        onResetOverride={() => {
          draft.current = null;
          edited.current = false;
          clearSettings(["newChatPrompt"]);
        }}
        title="Saved instructions"
        resetAction={
          mixed || settings.newChatPrompt !== "" ? (
            <SettingResetButton
              label="saved instructions"
              onClick={() => {
                draft.current = null;
                edited.current = false;
                updateSettings({ newChatPrompt: "" });
              }}
            />
          ) : null
        }
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            key={scopeKey}
            ref={inputRef}
            aria-label="New chat prompt"
            aria-describedby={promptPolicy === undefined ? undefined : policyDescriptionId}
            readOnly={promptPolicy !== undefined}
            disabled={!canWrite}
            rows={4}
            defaultValue={mixed ? "" : settings.newChatPrompt}
            placeholder={
              mixed
                ? "Mixed. Enter instructions for all selected targets."
                : "Instructions to append to the first message…"
            }
            onChange={(event) => {
              edited.current = true;
              draft.current = { scopeKey, value: event.target.value.trim() };
            }}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (
                edited.current &&
                canWrite &&
                promptPolicy === undefined &&
                (mixed || value !== settings.newChatPrompt)
              ) {
                updateSettings({ newChatPrompt: value });
              }
              edited.current = false;
            }}
          />
          {promptPolicy === undefined ? null : (
            <p id={policyDescriptionId} className="mt-2 text-xs text-muted-foreground">
              Managed by {promptPolicy.organization}.
            </p>
          )}
        </div>
      </SettingsRow>
    </>
  );
}
