/**
 * PluginSettings - Wire schemas for reading and saving an installation's
 * setting values (`plugins.settings.*`, gated on the `pluginSettings`
 * environment capability).
 *
 * Values belong to the installation, not to one registration: they survive
 * disable, re-enable, restarts and source changes, and are deleted when the
 * installation is removed. A write is checked against the fields the
 * installation's manifest declares when the write arrives.
 *
 * @module PluginSettings
 */
import * as Schema from "effect/Schema";

import { ForwardCompatibleArray } from "./baseSchemas.ts";
import { PluginInstallationId } from "./pluginCatalog.ts";
import {
  PLUGIN_SETTINGS_MAX_FIELDS,
  PluginSettingKey,
  PluginSettingValue,
} from "./pluginSettingFields.ts";

/** What clients see of an installation's saved settings. */
export const PluginSettingsValues = Schema.Struct({
  installationId: PluginInstallationId,
  /** Saved non-secret values. A field without one uses its default. */
  values: ForwardCompatibleArray(Schema.Struct({ key: Schema.String, value: PluginSettingValue })),
  /** Keys of secret fields that have a saved value. The values themselves are never sent. */
  secrets: Schema.Array(Schema.String),
});
export type PluginSettingsValues = typeof PluginSettingsValues.Type;

export const PluginSettingsInput = Schema.Struct({
  installationId: PluginInstallationId,
});
export type PluginSettingsInput = typeof PluginSettingsInput.Type;

const PluginSettingChange = Schema.Struct({
  key: PluginSettingKey,
  /** `null` clears the saved value: a field returns to its default, a secret is deleted. */
  value: Schema.NullOr(PluginSettingValue),
});

export const PluginSettingsUpdateInput = Schema.Struct({
  installationId: PluginInstallationId,
  changes: Schema.Array(PluginSettingChange).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PLUGIN_SETTINGS_MAX_FIELDS),
  ),
});
export type PluginSettingsUpdateInput = typeof PluginSettingsUpdateInput.Type;
