import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PluginState } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";

import { PluginRenderBoundary } from "../../../plugins/PluginRenderBoundary";
import type { PluginSettingsPanelEntry } from "../../../plugins/pluginRegistry";
import { pluginEnvironment } from "../../../state/plugins";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import { JsonSchemaSettingsForm } from "../JsonSchemaSettingsForm";
import { SettingsRow } from "../settingsLayout";

/** A plugin's settings under its row: the plugin's own panel, or rows from its schema. */
export function PluginSettingsRows({
  environmentId,
  plugin,
  customSettings,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugin: PluginState;
  readonly customSettings: PluginSettingsPanelEntry | undefined;
}) {
  if (customSettings === undefined) {
    return <PluginSettingsEditor environmentId={environmentId} plugin={plugin} />;
  }
  return <PluginCustomSettings entry={customSettings} />;
}

function PluginCustomSettings(props: { readonly entry: PluginSettingsPanelEntry }) {
  const Panel = props.entry.component;
  return (
    // Padded as a settings row, so a panel drawn as one lines up with the rows around it.
    <div className="px-3 py-3 sm:px-4">
      <PluginRenderBoundary
        owner={props.entry.owner}
        what="Its settings panel"
        resetKeys={[props.entry]}
        fallback={
          <p className="text-xs text-destructive">
            This plugin's settings panel stopped with an error.
          </p>
        }
      >
        <Panel />
      </PluginRenderBoundary>
    </div>
  );
}

function PluginSettingsEditor({
  environmentId,
  plugin,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugin: PluginState;
}) {
  const query = useEnvironmentQuery(
    pluginEnvironment.pluginSettings({ environmentId, input: { pluginId: plugin.id } }),
  );
  if (query.error) return <SettingsRow title="Could not load settings" description={query.error} />;
  if (!query.data) return <SettingsRow title="Loading settings…" role="status" />;
  return (
    <PluginSettingsFormView
      environmentId={environmentId}
      plugin={plugin}
      schema={query.data.settingsSchema}
      initialSettings={query.data.settings}
    />
  );
}

function PluginSettingsFormView({
  environmentId,
  plugin,
  schema,
  initialSettings,
}: {
  readonly environmentId: EnvironmentId;
  readonly plugin: PluginState;
  readonly schema: Schema.JsonObject | undefined;
  readonly initialSettings: Schema.JsonObject;
}) {
  const update = useAtomCommand(pluginEnvironment.updatePluginSettings, {
    label: "plugin settings",
    reportFailure: false,
  });
  const canSave = useAtomValue(
    pluginEnvironment.updatePluginSettings.permissionAtom(environmentId),
  );
  return (
    <JsonSchemaSettingsForm
      idPrefix={`plugin-setting-${plugin.id}`}
      label={plugin.name}
      schema={schema}
      settings={initialSettings}
      canSave={canSave}
      onSave={async (patch) => {
        const result = await update({ environmentId, input: { pluginId: plugin.id, patch } });
        if (result._tag === "Success") return { settings: result.value.settings };
        const error = squashAtomCommandFailure(result);
        return { problem: error instanceof Error ? error.message : "Could not save the settings." };
      }}
    />
  );
}
