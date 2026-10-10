import { useAtomValue } from "@effect/atom-react";
import { pluginSettingRows } from "@t3tools/client-runtime/state/pluginSettings";
import type { EnvironmentId, PluginInstallation } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { pluginSettingsEnvironment } from "../../state/plugins";
import { SettingsSection } from "../settings/components/SettingsSection";
import { describePluginSettingValue } from "./PluginSettingsValues.logic";

/**
 * The settings one installation declares and what is saved for them, read-only.
 * Renders nothing when the plugin declares none or the server cannot store them.
 */
export function PluginSettingsValues({
  environmentId,
  installation,
}: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
}) {
  const fields = installation.manifest?.settings ?? [];
  const result = useAtomValue(
    pluginSettingsEnvironment.values({
      environmentId,
      input: { installationId: installation.installationId },
    }),
  );
  const view = Option.getOrNull(AsyncResult.value(result));
  if (fields.length === 0 || view === null || view._tag === "unsupported") return null;
  return (
    <SettingsSection title={installation.manifest?.name ?? "Plugin"}>
      {pluginSettingRows(fields, view.values).map((row, index) => (
        <View
          key={row.field.key}
          className={
            index > 0 ? "gap-1 border-t border-border-subtle px-4 py-3" : "gap-1 px-4 py-3"
          }
        >
          <Text className="text-sm text-foreground-muted">{row.field.label}</Text>
          <Text selectable className="text-base text-foreground">
            {describePluginSettingValue(row)}
          </Text>
        </View>
      ))}
    </SettingsSection>
  );
}
