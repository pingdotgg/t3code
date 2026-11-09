import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useContext, useEffect } from "react";

import { pluginEnvironment } from "../../../state/plugins";
import { formatEnvironmentQueryError } from "../../../state/query";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { PluginRow } from "./PluginRow";

/** The page's own settings, with `children` first, then each plugin the environment has. */
export function PluginList({
  environmentId,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly children: ReactNode;
}) {
  const result = useAtomValue(pluginEnvironment.pluginsLive({ environmentId, input: {} }));
  const plugins = AsyncResult.getOrElse(result, () => null)?.plugins ?? null;
  const error = result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null;
  return (
    <>
      <SettingsSection title="Plugins">{children}</SettingsSection>
      <ScanPluginsFolder environmentId={environmentId} />
      <SettingsSection title="Installed plugins">
        {error === null ? null : <SettingsRow title="Could not load plugins" description={error} />}
        {plugins === null && error === null ? (
          <SettingsRow title="Loading plugins…" role="status" />
        ) : plugins?.length === 0 && error === null ? (
          <SettingsRow
            title="No plugins installed"
            description="Drop a plugin folder here to add it."
          />
        ) : (
          (plugins ?? []).map((plugin) => (
            <PluginRow key={plugin.id} environmentId={environmentId} plugin={plugin} />
          ))
        )}
      </SettingsSection>
    </>
  );
}

/** Has the server look at its plugins folder again, so folders copied there by hand are listed. */
function ScanPluginsFolder({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const canRescan = useAtomValue(pluginEnvironment.rescanPlugins.permissionAtom(environmentId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The server reads its plugins folder only when asked, so opening the page asks it.
  useEffect(() => {
    if (!canRescan) return;
    void runAtomCommand(
      registry,
      pluginEnvironment.rescanPlugins,
      { environmentId, input: {} },
      { label: "plugin folder scan", reportFailure: false, reportDefect: false },
    );
  }, [registry, environmentId, canRescan]);
  return null;
}
