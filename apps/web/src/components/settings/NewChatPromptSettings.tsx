import { useRef } from "react";

import { Textarea } from "../ui/textarea";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function NewChatPromptSettings() {
  const settings = useScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const edited = useRef(false);
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["newChatPrompt"]);
  const enabledMixed = useScopedSettingsMixed(["newChatPromptEnabled"]);

  return (
    <SettingsRow
      serverScoped
      settingKeys={["newChatPromptEnabled", "newChatPrompt"]}
      {...searchableSetting("new-chat-prompt")}
      description="Append saved instructions to your first message in each new chat. Off by default. Later messages and existing conversations are unchanged."
      resetAction={
        mixed || enabledMixed || settings.newChatPromptEnabled || settings.newChatPrompt !== "" ? (
          <SettingResetButton
            label="new chat prompt"
            onClick={() => updateSettings({ newChatPromptEnabled: false, newChatPrompt: "" })}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["newChatPromptEnabled"]}
          checked={settings.newChatPromptEnabled}
          onCheckedChange={(checked) => updateSettings({ newChatPromptEnabled: Boolean(checked) })}
          aria-label="Enable new chat prompt"
        />
      }
    >
      <div className="mt-3 max-w-2xl pb-3.5">
        <Textarea
          key={`${scopeKey}:${mixed}:${settings.newChatPrompt}`}
          aria-label="New chat prompt"
          rows={4}
          defaultValue={mixed ? "" : settings.newChatPrompt}
          placeholder={
            mixed
              ? "Mixed. Enter instructions for all selected targets."
              : "Instructions to append to the first message…"
          }
          onChange={() => {
            edited.current = true;
          }}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (edited.current && (mixed || value !== settings.newChatPrompt)) {
              updateSettings({ newChatPrompt: value });
            }
            edited.current = false;
          }}
        />
      </div>
    </SettingsRow>
  );
}
