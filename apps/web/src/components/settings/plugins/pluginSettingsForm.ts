import type * as Schema from "effect/Schema";

interface FieldBase {
  readonly key: string;
  readonly label: string;
  readonly description: string | undefined;
  readonly required: boolean;
}

export type PluginSettingsField = FieldBase &
  (
    | {
        readonly kind: "text";
        readonly defaultValue: string | undefined;
        readonly maxLength: number | undefined;
      }
    | { readonly kind: "secret" }
    | {
        readonly kind: "number";
        readonly integer: boolean;
        readonly defaultValue: number | undefined;
        readonly minimum: number | undefined;
        readonly maximum: number | undefined;
      }
    | { readonly kind: "boolean"; readonly defaultValue: boolean | undefined }
    | {
        readonly kind: "select";
        readonly options: ReadonlyArray<string | number>;
        readonly defaultValue: string | number | undefined;
      }
    | { readonly kind: "list"; readonly defaultValue: ReadonlyArray<string> | undefined }
  );

/**
 * The form for a plugin's settings. `json` means the schema uses shapes the generated form does
 * not cover, so the client edits the settings as JSON and relies on the server's validation.
 */
export type PluginSettingsForm =
  | { readonly kind: "none" }
  | { readonly kind: "fields"; readonly fields: ReadonlyArray<PluginSettingsField> }
  | { readonly kind: "json" };

const isRecord = (value: unknown): value is Schema.JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringOrUndefined = (value: unknown) => (typeof value === "string" ? value : undefined);
const numberOrUndefined = (value: unknown) => (typeof value === "number" ? value : undefined);
const isOption = (value: unknown): value is string | number =>
  typeof value === "string" || typeof value === "number";

const toField = (
  key: string,
  property: Schema.Json,
  required: boolean,
): PluginSettingsField | undefined => {
  if (!isRecord(property)) return undefined;
  const base = {
    key,
    label: stringOrUndefined(property.title) ?? key,
    description: stringOrUndefined(property.description),
    required,
  };
  if (Array.isArray(property.enum)) {
    const options = property.enum.filter(isOption);
    if (options.length === 0 || options.length !== property.enum.length) return undefined;
    return {
      ...base,
      kind: "select",
      options,
      defaultValue: isOption(property.default) ? property.default : undefined,
    };
  }
  switch (property.type) {
    case "string":
      return property.format === "t3-secret"
        ? { ...base, kind: "secret" }
        : {
            ...base,
            kind: "text",
            defaultValue: stringOrUndefined(property.default),
            maxLength: numberOrUndefined(property.maxLength),
          };
    case "number":
    case "integer":
      return {
        ...base,
        kind: "number",
        integer: property.type === "integer",
        defaultValue: numberOrUndefined(property.default),
        minimum: numberOrUndefined(property.minimum),
        maximum: numberOrUndefined(property.maximum),
      };
    case "boolean":
      return {
        ...base,
        kind: "boolean",
        defaultValue: typeof property.default === "boolean" ? property.default : undefined,
      };
    case "array": {
      const items = property.items;
      if (!isRecord(items) || items.type !== "string" || items.enum !== undefined) return undefined;
      const fallback = property.default;
      return {
        ...base,
        kind: "list",
        defaultValue:
          Array.isArray(fallback) && fallback.every((value) => typeof value === "string")
            ? fallback
            : undefined,
      };
    }
    default:
      return undefined;
  }
};

export function pluginSettingsForm(schema: Schema.JsonObject | undefined): PluginSettingsForm {
  if (schema === undefined) return { kind: "none" };
  if (schema.type !== "object" || !isRecord(schema.properties)) return { kind: "json" };
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields: Array<PluginSettingsField> = [];
  for (const [key, property] of Object.entries(schema.properties)) {
    const field = toField(key, property, required.has(key));
    if (field === undefined) return { kind: "json" };
    fields.push(field);
  }
  return fields.length === 0 ? { kind: "none" } : { kind: "fields", fields };
}
