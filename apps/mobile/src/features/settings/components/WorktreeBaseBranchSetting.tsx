import type { ServerSettingsPatch } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";

export function WorktreeBaseBranchSetting(props: {
  value: string | null;
  disabled: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  // Save on exit too: Android Back hides the keyboard without ending editing.
  const draft = useRef<{ text: string; over: string | null } | null>(null);
  const save = () => {
    const current = draft.current;
    draft.current = null;
    // Drop a draft typed over an older saved value: the updated value has already remounted the input.
    if (current === null || current.over !== props.value) return;
    const value = current.text.trim();
    if (props.value === null || value !== props.value) {
      props.onChange({ newWorktreesBaseBranch: value });
    }
  };
  const saveOnExit = useEffectEvent(save);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saves an unsent base branch draft to server settings when the setting unmounts
  useEffect(() => () => saveOnExit(), []);
  return (
    <View className="gap-2 px-4 py-3">
      <Text className="text-sm text-foreground">Base branch</Text>
      <Text className="text-sm text-foreground-muted">
        The branch, tag, or commit new worktrees start from, such as dev. Leave empty to use the
        repository’s default branch.
      </Text>
      <AppTextInput
        key={props.value}
        accessibilityLabel="Base branch for new worktrees"
        onChangeText={(text) => {
          draft.current = { text, over: props.value };
        }}
        defaultValue={props.value ?? ""}
        placeholder={props.value === null ? "Mixed" : "Repository default"}
        editable={!props.disabled}
        autoCapitalize="none"
        autoCorrect={false}
        className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
        onEndEditing={save}
      />
    </View>
  );
}
