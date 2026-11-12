import type { ServerSettingsPatch } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { View } from "react-native";

import { AppTextInput } from "../../../components/ui/AppText";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

export function NewChatPromptSettings(props: {
  enabled: boolean | null;
  prompt: string | null;
  disabled: Readonly<Record<"enabled" | "prompt", boolean>>;
  reason?: string | undefined;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  const draft = useRef<{ text: string; over: string | null } | null>(null);
  const save = () => {
    const pending = draft.current;
    draft.current = null;
    if (pending === null || pending.over !== props.prompt) return;
    const value = pending.text.trim();
    if (value !== props.prompt) props.onChange({ newChatPrompt: value });
  };
  const saveOnExit = useEffectEvent(save);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saves an unsent prompt when Android Back or navigation unmounts the section
  useEffect(() => () => saveOnExit(), []);

  return (
    <SettingsSection title="New chat prompt" footer={props.reason}>
      <SettingsSwitchRow
        label="Enable new chat prompt"
        subtitle={
          props.enabled === null
            ? "Mixed. Choose a value for all selected targets."
            : "Append saved instructions to your first message in each new chat. Off by default."
        }
        value={props.enabled}
        disabled={props.disabled.enabled}
        onValueChange={(value) => props.onChange({ newChatPromptEnabled: value })}
      />
      <View className="px-4 py-3">
        <AppTextInput
          key={props.prompt}
          accessibilityLabel="New chat prompt"
          defaultValue={props.prompt ?? ""}
          placeholder={
            props.prompt === null
              ? "Mixed. Enter instructions for all selected targets."
              : "Instructions to append to the first message…"
          }
          editable={!props.disabled.prompt}
          multiline
          autoCapitalize="sentences"
          className="min-h-24 rounded-xl px-3 py-2 text-base text-foreground"
          onChangeText={(text) => {
            draft.current = { text, over: props.prompt };
          }}
          onEndEditing={save}
        />
      </View>
    </SettingsSection>
  );
}
