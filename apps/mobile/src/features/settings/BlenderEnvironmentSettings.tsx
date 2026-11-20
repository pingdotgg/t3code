import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  type BlenderSettings,
  type BlenderStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

type Translate = ReturnType<typeof useGT>;

function describeStatus(status: BlenderStatus, gt: Translate): string | null {
  switch (status._tag) {
    case "Disabled":
      return null;
    case "NotFound":
      return status.source === "override"
        ? gt("No executable at the configured path.")
        : gt("Blender was not found on PATH or in standard install locations.");
    case "Available":
      return status.source === "path"
        ? gt("Blender {version} on PATH at {path}.", {
            version: status.version,
            path: status.executablePath,
          })
        : gt("Blender {version} at {path}.", {
            version: status.version,
            path: status.executablePath,
          });
    case "Unsupported":
      return gt(
        "Blender {version} at {path} is older than {minimum}, the oldest supported release.",
        {
          version: status.version,
          path: status.executablePath,
          minimum: status.minimumVersion,
        },
      );
    case "ProbeFailed":
      switch (status.reason) {
        case "spawn-failed":
          return gt("Blender at {path} could not start.", { path: status.executablePath });
        case "timed-out":
          return gt("Blender at {path} did not report its version in time.", {
            path: status.executablePath,
          });
        case "nonzero-exit":
          return gt("Blender at {path} exited with code {code}.", {
            path: status.executablePath,
            code: String(status.exitCode ?? "?"),
          });
        case "unrecognized-output":
          return gt("Blender at {path} did not print a version.", { path: status.executablePath });
      }
  }
}

export function BlenderEnvironmentSettings({
  environmentId,
  settings,
}: {
  readonly environmentId: EnvironmentId;
  readonly settings: BlenderSettings;
}) {
  const gt = useGT();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canEnable = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canChooseExecutable = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const status = useEnvironmentQuery(
    canRead && settings.enabled
      ? serverEnvironment.blenderStatus({ environmentId, input: {} })
      : null,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? settings.executablePath;
  const hasEdit = draft !== null && value.trim() !== settings.executablePath;

  async function save(patch: { enabled?: boolean; executablePath?: string }) {
    const result = await updateSettings({ environmentId, input: { patch: { blender: patch } } });
    if (AsyncResult.isSuccess(result)) {
      if (patch.executablePath !== undefined) {
        setDraft((current) => (current?.trim() === patch.executablePath ? null : current));
      }
      status.refresh();
    }
  }

  return (
    <SettingsSection title={gt("Blender")}>
      <SettingsSwitchRow
        label={gt("Use Blender")}
        subtitle={gt("Run the Blender installed on this environment.")}
        value={settings.enabled}
        disabled={!canEnable}
        onValueChange={(enabled) => void save({ enabled })}
      />
      <View className="gap-2 p-4">
        <AppText className="text-sm font-t3-medium text-foreground-muted">
          {gt("Blender executable")}
        </AppText>
        <View className="flex-row items-center gap-3">
          <AppTextInput
            accessibilityLabel={gt("Blender executable")}
            className="min-h-11 min-w-0 flex-1 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
            placeholder={gt("Detect automatically")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={canChooseExecutable}
            value={value}
            onChangeText={setDraft}
            onSubmitEditing={() => {
              if (hasEdit && canChooseExecutable) void save({ executablePath: value.trim() });
            }}
            returnKeyType="done"
          />
          {hasEdit ? (
            <Button
              label={gt("Save")}
              tone="secondary"
              disabled={!canChooseExecutable}
              onPress={() => void save({ executablePath: value.trim() })}
            />
          ) : null}
        </View>
        <AppText className="text-sm text-foreground-muted">
          {canChooseExecutable
            ? gt("Leave empty to find Blender on PATH or in standard install locations.")
            : gt("This connection cannot choose which executable the environment runs.")}
        </AppText>
        {settings.enabled && canRead ? (
          <AppText selectable className="text-sm text-foreground-muted">
            {status.isPending
              ? gt("Checking…")
              : (status.error ?? (status.data ? describeStatus(status.data, gt) : null))}
          </AppText>
        ) : null}
      </View>
      {settings.enabled && canRead ? (
        <ListActionRow
          label={gt("Check again")}
          disabled={status.isPending}
          onPress={status.refresh}
        />
      ) : null}
    </SettingsSection>
  );
}
