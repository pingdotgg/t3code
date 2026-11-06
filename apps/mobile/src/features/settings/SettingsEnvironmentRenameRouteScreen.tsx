import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";

export type SettingsEnvironmentRenameParams = {
  readonly environmentId: EnvironmentId;
};

export function SettingsEnvironmentRenameRouteScreen({
  route,
}: StaticScreenProps<SettingsEnvironmentRenameParams>) {
  const navigation = useNavigation();
  const { connectedEnvironments } = useRemoteConnections();
  const environment = connectedEnvironments.find(
    (candidate) => candidate.environmentId === route.params.environmentId,
  );
  const [label, setLabel] = useState(environment?.environmentLabel ?? "");
  const [saving, setSaving] = useState(false);
  const renameEnvironment = useAtomCommand(serverEnvironment.updateEnvironmentLabel, {
    reportFailure: false,
  });

  const save = async () => {
    const nextLabel = label.trim();
    const duplicate =
      nextLabel.length > 0 &&
      connectedEnvironments.some(
        (candidate) =>
          candidate.environmentId !== route.params.environmentId &&
          candidate.environmentLabel === nextLabel,
      );
    if (duplicate) {
      Dialog.alert(
        "Duplicate environment name",
        `Another environment is already named "${nextLabel}". Use this name for both environments?`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Use Name", onPress: () => void submit(nextLabel) },
        ],
      );
      return;
    }
    await submit(nextLabel);
  };

  const submit = async (nextLabel: string) => {
    setSaving(true);
    const result = await renameEnvironment({
      environmentId: route.params.environmentId,
      input: nextLabel,
    });
    setSaving(false);
    if (AsyncResult.isSuccess(result)) {
      navigation.goBack();
      return;
    }
    const error = Cause.squash(result.cause);
    Dialog.alert(
      "Could not rename environment",
      error instanceof Error ? error.message : "The environment name was not saved.",
    );
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader
        title="Rename Environment"
        dismissDisabled={saving}
        onClose={() => navigation.goBack()}
      />
      <View className="flex-1 gap-5 px-5 pt-5">
        <View className="gap-1.5">
          <Text className="text-sm text-foreground-muted">
            Clear the name to use the environment's machine name.
          </Text>
          <TextInput
            autoFocus
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={40}
            placeholder="Environment name"
            value={label}
            editable={!saving && environment !== undefined}
            onChangeText={setLabel}
            onSubmitEditing={() => void save()}
            className="rounded-[14px] border border-input-border bg-input px-4 py-3 text-base text-foreground"
          />
        </View>
        <View className="flex-row gap-3">
          <Pressable
            className="min-h-[46px] flex-1 items-center justify-center rounded-[14px] border border-input-border bg-input active:opacity-70"
            disabled={saving}
            onPress={() => navigation.goBack()}
          >
            <Text className="font-t3-bold text-foreground">Cancel</Text>
          </Pressable>
          <Pressable
            className="min-h-[46px] flex-1 items-center justify-center rounded-[14px] bg-primary active:opacity-70 disabled:opacity-50"
            disabled={saving || environment === undefined}
            onPress={() => void save()}
          >
            {saving ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text className="font-t3-bold text-primary-foreground">Save</Text>
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}
