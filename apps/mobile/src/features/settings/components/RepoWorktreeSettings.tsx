import type { ServerSettingsPatch } from "@t3tools/contracts";
import { T, useGT } from "gt-react-native";
import { useRef } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

/** Rows inside an existing section. The first draws a top border, so another row must precede it. */
export function RepoWorktreeSettings(props: {
  enabled: boolean | null;
  instructions: string | null;
  /** Each setting can be managed by policy on its own. */
  disabled: { readonly enabled: boolean; readonly instructions: boolean };
  projectSelected: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  const gt = useGT();
  const instructionsEdited = useRef(false);
  const guidanceHelp = gt(
    "Instructions for agents working in these repositories, such as base branches and submodule rules.",
  );
  return (
    <>
      <View className="border-t border-border-subtle">
        <SettingsSwitchRow
          icon="folder"
          label={gt("Multi-Repository Project Folder")}
          subtitle={
            props.projectSelected
              ? gt(
                  "Create or reuse separate worktrees for the Git repositories inside this project folder as needed.",
                )
              : gt(
                  "Create or reuse separate worktrees for the Git repositories inside each project folder as needed. Projects can override it.",
                )
          }
          value={props.enabled}
          disabled={props.disabled.enabled}
          onValueChange={(value) => props.onChange({ repoWorktrees: value })}
        />
      </View>
      {props.enabled !== false ? (
        <View className="gap-2 border-t border-border-subtle px-4 py-3">
          <View className="gap-1">
            <Text textRole="body" className="text-foreground">
              <T>Repository Guidance</T>
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              {guidanceHelp}
            </Text>
          </View>
          <AppTextInput
            key={props.instructions}
            accessibilityLabel={gt("Repository Guidance")}
            accessibilityHint={guidanceHelp}
            onChangeText={() => {
              instructionsEdited.current = true;
            }}
            defaultValue={props.instructions ?? ""}
            placeholder={
              props.instructions === null
                ? gt("Mixed. Enter guidance for all selected targets.")
                : gt("Start api work from develop. Start shared/framework work from team-develop.")
            }
            editable={!props.disabled.instructions}
            multiline
            autoCapitalize="sentences"
            className="min-h-24 rounded-xl px-3 py-2 text-base text-foreground"
            onEndEditing={(event) => {
              const value = event.nativeEvent.text.trim();
              if (
                !props.disabled.instructions &&
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
