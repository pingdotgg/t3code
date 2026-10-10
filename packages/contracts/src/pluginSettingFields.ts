/**
 * PluginSettingFields - Typed settings a plugin declares in its manifest.
 *
 * A plugin that declares the `settings` capability lists its fields under
 * `settings` in `t3-plugin.json`. Values belong to the installation: they
 * survive disable, re-enable, restarts and source changes, and are deleted
 * when the installation is removed. Every field applies to the whole
 * environment.
 *
 * Secret values are write-only. Clients can set, replace or clear a secret
 * and learn whether one is saved, but the server never sends a secret back.
 * Only the plugin itself reads it.
 *
 * @module PluginSettingFields
 */
import * as Schema from "effect/Schema";

import { ForwardCompatibleArray, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The manifest capability that grants settings, secrets and plugin storage. */
export const PLUGIN_SETTINGS_CAPABILITY = "settings";

export const PLUGIN_SETTINGS_MAX_FIELDS = 32;
const PLUGIN_SETTING_MAX_OPTIONS = 32;
export const PLUGIN_SETTING_TEXT_MAX_LENGTH = 2000;
export const PLUGIN_SETTING_SECRET_MAX_LENGTH = 8192;

/** A setting's identity within its installation, such as `apiUrl`. */
export const PluginSettingKey = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]*$/),
);
export type PluginSettingKey = typeof PluginSettingKey.Type;

const PluginSettingLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(60));
const PluginSettingDescription = Schema.String.check(Schema.isMaxLength(240));
const PluginSettingText = Schema.String.check(Schema.isMaxLength(PLUGIN_SETTING_TEXT_MAX_LENGTH));

/** A select option. `value` is what is saved and must stay stable; `label` is display text. */
const PluginSettingOption = Schema.Struct({
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  label: PluginSettingLabel,
});

const fieldBase = {
  key: PluginSettingKey,
  label: PluginSettingLabel,
  description: Schema.optionalKey(PluginSettingDescription),
};

const PluginTextSettingField = Schema.Struct({
  type: Schema.Literal("text"),
  ...fieldBase,
  default: Schema.optionalKey(PluginSettingText),
});

/** Never has a default, and its value never leaves the server. */
const PluginSecretSettingField = Schema.Struct({
  type: Schema.Literal("secret"),
  ...fieldBase,
});

const PluginBooleanSettingField = Schema.Struct({
  type: Schema.Literal("boolean"),
  ...fieldBase,
  default: Schema.optionalKey(Schema.Boolean),
});

const PluginNumberSettingField = Schema.Struct({
  type: Schema.Literal("number"),
  ...fieldBase,
  default: Schema.optionalKey(Schema.Finite),
  min: Schema.optionalKey(Schema.Finite),
  max: Schema.optionalKey(Schema.Finite),
  integer: Schema.optionalKey(Schema.Boolean),
});

const PluginSelectSettingField = Schema.Struct({
  type: Schema.Literal("select"),
  ...fieldBase,
  options: Schema.Array(PluginSettingOption).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PLUGIN_SETTING_MAX_OPTIONS),
  ),
  default: Schema.optionalKey(Schema.String),
});

/** A saved setting value; which one a field takes depends on its `type`. */
export const PluginSettingValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);
export type PluginSettingValue = typeof PluginSettingValue.Type;

const PluginSettingFieldShape = Schema.Union([
  PluginTextSettingField,
  PluginSecretSettingField,
  PluginBooleanSettingField,
  PluginNumberSettingField,
  PluginSelectSettingField,
]);
type PluginSettingFieldShape = typeof PluginSettingFieldShape.Type;

/**
 * Why `value` cannot be saved for `field`, or undefined when it can. The
 * message never repeats the value, so it is safe for secrets.
 */
export const pluginSettingValueProblem = (
  field: PluginSettingFieldShape,
  value: PluginSettingValue,
): string | undefined => {
  switch (field.type) {
    case "text":
      if (typeof value !== "string") return `${field.label} must be text.`;
      if (value.length > PLUGIN_SETTING_TEXT_MAX_LENGTH)
        return `${field.label} must be at most ${PLUGIN_SETTING_TEXT_MAX_LENGTH} characters.`;
      return undefined;
    case "secret":
      if (typeof value !== "string" || value.length === 0)
        return `${field.label} must be non-empty text.`;
      if (value.length > PLUGIN_SETTING_SECRET_MAX_LENGTH)
        return `${field.label} must be at most ${PLUGIN_SETTING_SECRET_MAX_LENGTH} characters.`;
      return undefined;
    case "boolean":
      return typeof value === "boolean" ? undefined : `${field.label} must be on or off.`;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        return `${field.label} must be a number.`;
      if (field.integer === true && !Number.isInteger(value))
        return `${field.label} must be a whole number.`;
      if (field.min !== undefined && value < field.min)
        return `${field.label} must be at least ${field.min}.`;
      if (field.max !== undefined && value > field.max)
        return `${field.label} must be at most ${field.max}.`;
      return undefined;
    case "select":
      return typeof value === "string" && field.options.some((option) => option.value === value)
        ? undefined
        : `${field.label} must be one of its options.`;
  }
};

const fieldDeclarationProblem = (field: PluginSettingFieldShape): string | undefined => {
  if (field.type === "number" && field.min !== undefined && field.max !== undefined)
    if (field.min > field.max) return `${field.key}: min is greater than max.`;
  if (field.type === "select") {
    const values = new Set(field.options.map((option) => option.value));
    if (values.size !== field.options.length) return `${field.key}: option values repeat.`;
  }
  if (field.type !== "secret" && field.default !== undefined) {
    const problem = pluginSettingValueProblem(field, field.default);
    if (problem !== undefined) return `${field.key}: the default is invalid. ${problem}`;
  }
  return undefined;
};

/** One declared setting. */
export const PluginSettingField = PluginSettingFieldShape.check(
  Schema.makeFilter((field) => fieldDeclarationProblem(field) ?? true),
);
export type PluginSettingField = typeof PluginSettingField.Type;

/** The `settings` list of a manifest: unique keys, at most 32 fields. */
export const PluginSettingsDeclaration = Schema.Array(PluginSettingField).check(
  Schema.isMaxLength(PLUGIN_SETTINGS_MAX_FIELDS),
  Schema.makeFilter((fields) => {
    const keys = new Set(fields.map((field) => field.key));
    return keys.size === fields.length || "settings: keys repeat.";
  }),
);

/**
 * The declared fields as clients read them from the catalogue. A field type a
 * newer server knows and this client does not is dropped, not the whole row.
 */
export const PluginSettingsFieldList = ForwardCompatibleArray(PluginSettingField);

/** The value a plugin reads for a non-secret field: what was saved if it still fits, else the default. */
export const resolvePluginSettingValue = (
  field: PluginSettingField,
  saved: PluginSettingValue | undefined,
): PluginSettingValue | undefined => {
  if (field.type === "secret") return undefined;
  if (saved !== undefined && pluginSettingValueProblem(field, saved) === undefined) return saved;
  return field.default;
};
