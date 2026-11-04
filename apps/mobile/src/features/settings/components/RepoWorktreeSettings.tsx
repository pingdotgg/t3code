import type { ServerSettingsPatch } from "@t3tools/contracts";
import { useRef } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

export function RepoWorktreeSettings(props: {
  enabled: boolean | null;
  instructions: string | null;
  disabled: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  const instructionsEdited = useRef(false);
  return (
    <SettingsSection title="Repository worktrees">
      <SettingsSwitchRow
        icon="folder"
        label="Repository worktrees"
        subtitle="For a folder of several Git repositories. The thread stays in the folder, and agents create or reuse a worktree for each repository the work needs. Checkpoints, diffs, and rollback cover only the folder, not those worktrees."
        value={props.enabled}
        disabled={props.disabled}
        onValueChange={(value) => props.onChange({ repoWorktrees: value })}
      />
      {props.enabled !== false ? (
        <View className="gap-2 px-4 py-3">
          <Text className="text-sm text-foreground-muted">
            Guidance for agents, for example which branch each repository's work starts from.
          </Text>
          <AppTextInput
            key={props.instructions}
            accessibilityLabel="Repository worktree guidance"
            onChangeText={() => {
              instructionsEdited.current = true;
            }}
            defaultValue={props.instructions ?? ""}
            placeholder={
              props.instructions === null
                ? "Mixed. Enter guidance for all selected targets."
                : "Start api work from develop. Start shared/framework work from team-develop."
            }
            editable={!props.disabled}
            multiline
            autoCapitalize="sentences"
            className="min-h-24 rounded-xl px-3 py-2 text-base text-foreground"
            onEndEditing={(event) => {
              const value = event.nativeEvent.text.trim();
              if (
                !props.disabled &&
                instructionsEdited.current &&
                (props.instructions === null || value !== props.instructions)
              )
                props.onChange({ repoWorktreeInstructions: value });
              instructionsEdited.current = false;
            }}
          />
        </View>
      ) : null}
    </SettingsSection>
  );
}
