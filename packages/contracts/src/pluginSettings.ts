/**
 * Declarative plugin settings: the shared schema shape and the restricted field
 * vocabulary the host settings form can actually render.
 *
 * @module pluginSettings
 */
import * as Schema from "effect/Schema";

import type { ProviderSettingsFormControl } from "./settings.ts";
import { readSettingsFormAnnotation } from "./settings.ts";

/**
 * A settings schema: a struct whose fields carry `providerSettingsForm`
 * annotations. Shared by first-party providers and plugins.
 *
 * The annotation name is historical — it predates plugins. Renaming it would
 * touch every provider, so plugins deliberately reuse the same vocabulary
 * rather than introducing a second one.
 */
export type SettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

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
export const findPluginSettingsSchemaViolations = (
  schema: SettingsSchema,
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

  const violations: Array<PluginSettingsSchemaViolation> = [];
  for (const [key, fieldSchema] of Object.entries(schema.fields)) {
    const annotation = readSettingsFormAnnotation(fieldSchema);
    // Hidden fields are never rendered (`ProviderSettingsForm` drops them before
    // building a field model), so the control vocabulary does not constrain them.
    // This is load-bearing, not a nicety: every first-party provider parks
    // non-renderable state (`enabled: Boolean`, `customModels: Array`) in the same
    // schema behind `hidden: true`. Validating hidden fields would reject all five.
    if (annotation.hidden === true) continue;

    const control: ProviderSettingsFormControl = annotation.control ?? "text";
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
