import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/AppText";
import { cn } from "../../../lib/cn";

/** A custom worktree command; empty keeps the built-in step. `null` means the selection is mixed. */
export function WorktreeCommandField(props: {
  readonly label: string;
  readonly subtitle: string;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const next = draft?.trim() ?? null;
    setDraft(null);
    if (props.disabled || next === null || next === props.value) return;
    props.onCommit(next);
  };
  return (
    <View className={cn("gap-2 p-4", props.disabled && "opacity-[0.45]")}>
      <Text className="text-lg text-foreground android:text-base">{props.label}</Text>
      <Text className="text-sm text-foreground-muted">{props.subtitle}</Text>
      <AppTextInput
        className="font-mono text-sm"
        value={draft ?? props.value ?? ""}
        onChangeText={setDraft}
        onBlur={commit}
        onSubmitEditing={commit}
        returnKeyType="done"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        placeholder={props.value === null ? "Mixed" : "Built-in"}
        placeholderTextColorClassName="accent-foreground-muted"
        accessibilityLabel={props.label}
        editable={!props.disabled}
      />
    </View>
  );
}
