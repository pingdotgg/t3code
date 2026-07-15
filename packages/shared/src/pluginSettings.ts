/**
 * Plugin settings POLICY: the renderable field vocabulary the host form can draw,
 * and the compatibility fingerprint for stored values.
 *
 * Runtime logic, so it lives here rather than in `packages/contracts`, which
 * AGENTS.md requires to stay schema-only. The schema TYPE stays in contracts.
 *
 * @module pluginSettings
 */
import type { ProviderSettingsFormControl, SettingsSchema } from "@t3tools/contracts";
import { readSettingsFormAnnotation } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";

export type { SettingsSchema };

/**
 * A settings schema: a struct whose fields carry `providerSettingsForm`
 * annotations. Shared by first-party providers and plugins.
 *
 * The annotation name is historical — it predates plugins. Renaming it would
 * touch every provider, so plugins deliberately reuse the same vocabulary
 * rather than introducing a second one.
 */
/**
 * The only field shapes `ProviderSettingsForm` can render.
 *
 * This is NOT a stylistic restriction. The renderer defaults `control` to
 * `"text"` for every field and reads values with
 * `typeof value === "string" ? value : ""` — so a Number/Array/Struct field is
 * rendered as a text box, always reads as `""`, and every write it produces
 * fails server validation. Rejecting at registration turns a silent, permanent
 * mis-render into an immediate, actionable error.
 *
 * Widening this set means widening the renderer first.
 */
const CONTROL_JSON_TYPE: Record<ProviderSettingsFormControl, "string" | "boolean"> = {
  text: "string",
  password: "string",
  textarea: "string",
  switch: "boolean",
};

export interface PluginSettingsSchemaViolation {
  readonly field: string;
  readonly reason: string;
}

/**
 * Identifies the shape that produced a stored settings payload.
 *
 * Stored alongside the values so an upgrade that changes the schema can be
 * detected rather than silently misread. Derived from the JSON Schema, so it
 * tracks exactly what affects encoding/decoding — renaming a field or changing
 * its type changes the fingerprint, while editing a description does not.
 *
 * Not a security control: a fingerprint match means "same shape", not "same
 * plugin". It exists to make incompatibility detectable and recoverable.
 */
export const fingerprintSettingsSchema = (schema: SettingsSchema): string => {
  try {
    const root = Schema.toJsonSchemaDocument(schema).schema as Record<string, unknown>;
    const properties =
      typeof root["properties"] === "object" && root["properties"] !== null
        ? (root["properties"] as Record<string, unknown>)
        : {};
    const required = new Set(
      Array.isArray(root["required"]) ? (root["required"] as ReadonlyArray<unknown>) : [],
    );

    // Canonicalise to ONLY what affects whether stored values still decode: each
    // field's name, its encoded type, and whether it is required.
    //
    // Raw JSON.stringify of the JSON Schema was wrong in both directions. It changed
    // when a DESCRIPTION or title changed — so a documentation-only plugin update
    // marked every user's stored settings incompatible and bricked their config —
    // and it changed on mere field REORDERING, which affects nothing. Sorting by key
    // removes the ordering sensitivity; projecting to (type, required) removes the
    // cosmetic sensitivity.
    //
    // Adding or removing a decoding default IS still detected, because a defaulted
    // field drops out of `required`. Changing a default's VALUE is deliberately NOT
    // detected: the stored values still decode, so there is nothing to repair.
    const canonical = Object.keys(properties)
      .sort()
      .map((key) => ({
        key,
        type: jsonTypeOf(properties[key]) ?? "unknown",
        required: required.has(key),
      }));
    return JSON.stringify(canonical);
  } catch {
    // Unfingerprintable schemas are already rejected by
    // findPluginSettingsSchemaViolations; this keeps the function total.
    return "";
  }
};

/**
 * The field's encoded JSON type, or null when it isn't a single plain type.
 *
 * Unwraps nullable unions: `withDecodingDefault` — which providers use on nearly
 * every field — encodes as `anyOf: [{type:"string"},{type:"null"}]`, since an
 * absent value is permitted and filled by the default. Treating that as "no type"
 * would reject defaults, which are the main reason to declare settings at all.
 *
 * Genuinely mixed unions still return null, which is what keeps Number out:
 * it encodes as `anyOf: [{type:"number"}, {type:"string",enum:["NaN"]}, …]` to
 * carry NaN/Infinity, so its non-null members are not a single type.
 */
const jsonTypeOf = (property: unknown): string | null => {
  if (typeof property !== "object" || property === null) return null;
  const record = property as Record<string, unknown>;
  const type = record["type"];
  if (typeof type === "string") return type;

  const anyOf = record["anyOf"];
  if (!Array.isArray(anyOf)) return null;
  const nonNullTypes = new Set(
    anyOf
      .map((member) =>
        typeof member === "object" && member !== null
          ? (member as Record<string, unknown>)["type"]
          : undefined,
      )
      .filter((memberType) => memberType !== "null"),
  );
  if (nonNullTypes.size !== 1) return null;
  const only = [...nonNullTypes][0];
  return typeof only === "string" ? only : null;
};

/**
 * Checks a settings schema against the renderable vocabulary.
 *
 * Returns every violation (not just the first) so a plugin author fixes the
 * whole schema in one pass rather than one field per install attempt.
 */
export interface PluginSettingsValidationOptions {
  /**
   * Whether a `password` control is permitted.
   *
   * FALSE for plugins. In this codebase `password` means "mask the input", NOT
   * "store securely" — OpenCode's own `serverPassword` uses it and its description
   * says "Stored in plain text on disk." Plugin settings are stored as ordinary
   * plaintext in `plugin_settings` and are readable by anyone with `plugins:manage`,
   * so a plugin author reaching for `password` to hold an API key would be silently
   * wrong. Secrets are deliberately out of scope for this slice; a plugin needing one
   * uses SecretsCapability, which already exists. Fail closed until the secret
   * settings slice lands, then revisit.
   *
   * TRUE for first-party provider schemas, which predate this and where the field
   * descriptions already tell the user what is stored.
   */
  readonly allowPasswordControl: boolean;
}

export const findPluginSettingsSchemaViolations = (
  schema: SettingsSchema,
  options: PluginSettingsValidationOptions = { allowPasswordControl: true },
): ReadonlyArray<PluginSettingsSchemaViolation> => {
  let document: ReturnType<typeof Schema.toJsonSchemaDocument>;
  try {
    document = Schema.toJsonSchemaDocument(schema);
  } catch (error) {
    return [
      {
        field: "<schema>",
        reason: `is not JSON-Schema-derivable: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }

  const root = document.schema as Record<string, unknown>;
  if (root["type"] !== "object") {
    return [{ field: "<schema>", reason: "must be a Schema.Struct with an object root" }];
  }
  const properties = root["properties"];
  if (typeof properties !== "object" || properties === null) {
    return [{ field: "<schema>", reason: "must declare at least one field" }];
  }

  const required = new Set(
    Array.isArray(root["required"]) ? (root["required"] as ReadonlyArray<unknown>) : [],
  );

  const violations: Array<PluginSettingsSchemaViolation> = [];
  for (const [key, fieldSchema] of Object.entries(schema.fields)) {
    const annotation = readSettingsFormAnnotation(fieldSchema);
    if (annotation.hidden === true) {
      // A hidden field the form can never supply, and that decoding cannot fill in,
      // makes the plugin unconfigurable: the form omits it, so EVERY write fails
      // validation forever. Reject it here rather than shipping a settings page that
      // cannot be saved. (A hidden field WITH a decoding default is fine — that is
      // how every first-party provider parks non-renderable state like
      // `enabled: Boolean` / `customModels: Array`, and those are absent from
      // `required`.)
      if (required.has(key)) {
        violations.push({
          field: key,
          reason:
            "is hidden and required with no decoding default, so the settings form can never supply it and every save would fail",
        });
      }
      // Otherwise hidden fields are never rendered (`ProviderSettingsForm` drops
      // them before building a field model), so the control vocabulary does not
      // constrain them.
      continue;
    }

    const control: ProviderSettingsFormControl = annotation.control ?? "text";
    if (control === "password" && !options.allowPasswordControl) {
      violations.push({
        field: key,
        reason:
          'uses the "password" control, which only masks the input — plugin settings are stored as ordinary plaintext and are readable by anyone who can manage plugins. Use SecretsCapability for secrets',
      });
      continue;
    }
    const expected = CONTROL_JSON_TYPE[control];
    const actual = jsonTypeOf((properties as Record<string, unknown>)[key]);
    if (actual !== expected) {
      violations.push({
        field: key,
        reason:
          actual === null
            ? `control "${control}" requires a ${expected} field, but this field's encoded form is not a plain ${expected} (unions, numbers, arrays and nested structs are not renderable)`
            : `control "${control}" requires a ${expected} field, but this field encodes as ${actual}`,
      });
    }
  }
  return violations;
};
