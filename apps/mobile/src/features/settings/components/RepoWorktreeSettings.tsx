import type { ServerSettingsPatch } from "@t3tools/contracts";
import { useRef } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

const GUIDANCE_HELP =
  "Instructions for agents working in these repositories, such as base branches and submodule rules.";

/** Rows inside an existing section. The first draws a top border, so another row must precede it. */
export function RepoWorktreeSettings(props: {
  enabled: boolean | null;
  instructions: string | null;
  disabled: boolean;
  projectSelected: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  const instructionsEdited = useRef(false);
  return (
    <>
      <View className="border-t border-border-subtle">
        <SettingsSwitchRow
          icon="folder"
          label="Multi-Repository Project Folder"
          subtitle={
            props.projectSelected
              ? "Create or reuse separate worktrees for the Git repositories inside this project folder as needed."
              : "Create or reuse separate worktrees for the Git repositories inside each project folder as needed. Projects can override it."
          }
          value={props.enabled}
          disabled={props.disabled}
          onValueChange={(value) => props.onChange({ repoWorktrees: value })}
        />
      </View>
      {props.enabled !== false ? (
        <View className="gap-2 border-t border-border-subtle px-4 py-3">
          <View className="gap-1">
            <Text textRole="body" className="text-foreground">
              Repository Guidance
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              {GUIDANCE_HELP}
            </Text>
          </View>
          <AppTextInput
            key={props.instructions}
            accessibilityLabel="Repository Guidance"
            accessibilityHint={GUIDANCE_HELP}
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
    </>
  );
}
