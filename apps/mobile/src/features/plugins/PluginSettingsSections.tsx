import { useAtomValue } from "@effect/atom-react";
import { supportsPluginSettings } from "@t3tools/client-runtime/state/pluginSettings";
import type { EnvironmentId, ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { AppText as Text } from "../../components/AppText";
import { pluginEnvironment } from "../../state/plugins";
import { PluginSettingsValues } from "./PluginSettingsValues";

/**
 * The saved settings of each installed plugin that declares any, read-only:
 * mobile always pairs with standard scopes, so it cannot save them. Renders
 * nothing on a server without plugin settings or when no plugin declares any.
 */
export function PluginSettingsSections({
  environmentId,
  capabilities,
}: {
  readonly environmentId: EnvironmentId;
  readonly capabilities: ExecutionEnvironmentCapabilities | undefined;
}) {
  if (!supportsPluginSettings(capabilities)) return null;
  return <InstalledPluginSettings environmentId={environmentId} />;
}

function InstalledPluginSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const catalog = Option.getOrNull(
    AsyncResult.value(useAtomValue(pluginEnvironment.catalog({ environmentId, input: {} }))),
  );
  if (catalog?._tag !== "available") return null;
  const installations = catalog.installations.filter(
    (installation) => (installation.manifest?.settings?.length ?? 0) > 0,
  );
  if (installations.length === 0) return null;
  return (
    <>
      {installations.map((installation) => (
        <PluginSettingsValues
          key={installation.installationId}
          environmentId={environmentId}
          installation={installation}
        />
      ))}
      <Text className="px-2 text-sm text-foreground-muted">
        Plugin settings are view-only on mobile. Edit them from an administrative web or desktop
        connection.
      </Text>
    </>
  );
}
