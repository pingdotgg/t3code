import {
  acceptsSecretReference,
  isSecretSetting,
  type ProviderSettingsFormAnnotation,
  type ProviderSettingsFormControl,
  type ProviderSettingsFormOption,
  type ProviderSettingsFormSchemaAnnotation,
  type SecretReference,
} from "@t3tools/contracts";
import type { ProviderClientDefinition } from "@t3tools/provider-core/client";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type SettingsFormDefinition = Pick<ProviderClientDefinition, "settingsSchema"> & {
  readonly driverKind?: ProviderClientDefinition["driverKind"];
};

export interface ProviderSettingsFieldModel {
  readonly key: string;
  readonly control: ProviderSettingsFormControl;
  readonly label: string;
  readonly description?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly clearWhenEmpty: "omit" | "persist";
  /** Kept in the server's secret store: a saved value arrives as `SECRET_REDACTED` and never shows. */
  readonly secret?: boolean | undefined;
  /** Typed `SettingsSecretValue`: may name a secret provider reference instead of a value. */
  readonly acceptsSecretReference?: boolean | undefined;
  readonly defaultBooleanValue?: boolean | undefined;
  readonly options?: ReadonlyArray<ProviderSettingsFormOption> | undefined;
}

function titleizeFieldKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (char) => char.toUpperCase());
}

function readFieldAnnotations(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
) {
  return Schema.resolveAnnotationsKey(fieldSchema) ?? Schema.resolveAnnotations(fieldSchema);
}

function readFieldAnnotationString(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
  key: "title" | "description",
): string | undefined {
  const annotations = readFieldAnnotations(fieldSchema);
  const value = annotations?.[key];
  return typeof value === "string" ? value : undefined;
}

function readProviderSettingsFormAnnotation(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
): ProviderSettingsFormAnnotation {
  const annotation = readFieldAnnotations(fieldSchema)?.providerSettingsForm;
  return annotation ?? {};
}

function readProviderSettingsFormSchemaAnnotation(
  definition: SettingsFormDefinition,
): ProviderSettingsFormSchemaAnnotation {
  return Schema.resolveAnnotations(definition.settingsSchema)?.providerSettingsFormSchema ?? {};
}

function readFieldBooleanDefault(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
): boolean | undefined {
  const decodeDefault = Schema.decodeUnknownOption(fieldSchema as Schema.Decoder<unknown>);
  const decoded = decodeDefault(undefined);
  return Option.isSome(decoded) && typeof decoded.value === "boolean" ? decoded.value : undefined;
}

function readProviderConfigString(config: unknown, key: string): string {
  if (config === null || typeof config !== "object") return "";
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/**
 * Schema-annotated provider runtime fields, shared by web and mobile form renderers.
 * Driver-specific setup/auth/models stay in each client's hand-built overlays.
 */
export function deriveProviderSettingsFields(
  definition: SettingsFormDefinition,
  value?: unknown,
): ReadonlyArray<ProviderSettingsFieldModel> {
  const isLocalAcp =
    definition.driverKind === "acpRegistry" &&
    readProviderConfigString(value, "source") === "local";
  const schemaAnnotation = readProviderSettingsFormSchemaAnnotation(definition);
  const orderedKeys = new Map(
    (schemaAnnotation.order ?? []).map((key, index) => [key, index] as const),
  );
  const orderFallbackOffset = orderedKeys.size;

  return Object.keys(definition.settingsSchema.fields)
    .map((key, index) => ({ key, index }))
    .sort((left, right) => {
      return (
        (orderedKeys.get(left.key) ?? orderFallbackOffset + left.index) -
        (orderedKeys.get(right.key) ?? orderFallbackOffset + right.index)
      );
    })
    .flatMap(({ key }) => {
      const fieldSchema = definition.settingsSchema.fields[key]!;
      const formAnnotation = readProviderSettingsFormAnnotation(fieldSchema);
      if (formAnnotation.hidden) return [];
      if (isLocalAcp && key !== "source" && key !== "commandPath") return [];

      const annotatedTitle = readFieldAnnotationString(fieldSchema, "title");
      const annotatedDescription = readFieldAnnotationString(fieldSchema, "description");
      return [
        {
          key,
          control: formAnnotation.control ?? "text",
          label:
            isLocalAcp && key === "commandPath"
              ? "Executable"
              : (annotatedTitle ?? titleizeFieldKey(key)),
          ...(isLocalAcp && key === "commandPath"
            ? { description: "Executable name or path on this environment." }
            : annotatedDescription !== undefined
              ? { description: annotatedDescription }
              : {}),
          ...(isLocalAcp && key === "commandPath"
            ? { placeholder: "e.g. dsh" }
            : formAnnotation.placeholder !== undefined
              ? { placeholder: formAnnotation.placeholder }
              : {}),
          clearWhenEmpty: formAnnotation.clearWhenEmpty ?? "omit",
          ...(isSecretSetting(fieldSchema) ? { secret: true } : {}),
          ...(acceptsSecretReference(fieldSchema) ? { acceptsSecretReference: true } : {}),
          ...(formAnnotation.control === "switch"
            ? { defaultBooleanValue: readFieldBooleanDefault(fieldSchema) }
            : {}),
          ...(formAnnotation.control === "select" && formAnnotation.options
            ? { options: formAnnotation.options }
            : {}),
        } satisfies ProviderSettingsFieldModel,
      ];
    });
}

export function nextProviderConfigWithFieldValue(
  config: unknown,
  field: ProviderSettingsFieldModel,
  value: string | boolean | SecretReference,
): Record<string, unknown> | undefined {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};

  if (typeof value === "object") {
    base[field.key] = value;
    return base;
  }

  if (typeof value === "boolean") {
    const emptyBooleanValue = field.defaultBooleanValue ?? false;
    if (field.clearWhenEmpty === "omit" && value === emptyBooleanValue) {
      delete base[field.key];
    } else {
      base[field.key] = value;
    }
    return Object.keys(base).length > 0 ? base : undefined;
  }

  const trimmed = value.trim();
  if (field.clearWhenEmpty === "omit" && trimmed.length === 0) {
    delete base[field.key];
  } else {
    base[field.key] = value;
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

export function readProviderConfigFieldString(config: unknown, key: string): string {
  return readProviderConfigString(config, key);
}

export function readProviderConfigFieldBoolean(
  config: unknown,
  key: string,
  defaultValue = false,
): boolean {
  if (config === null || typeof config === "undefined" || typeof config !== "object") {
    return defaultValue;
  }
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : defaultValue;
}

/**
 * Editable rows seeded from a configured value. `seen` is the value the rows
 * were last reconciled against; `lastPublished` is what the rows last sent to
 * the owner, so its echo does not reseed rows (and drop their ids) mid-edit.
 */
export interface RowsDraft<V, R> {
  readonly rows: ReadonlyArray<R>;
  readonly seen: V;
  readonly lastPublished: V | undefined;
}

export function seedRowsDraft<V, R>(
  value: V,
  toRows: (value: V) => ReadonlyArray<R>,
): RowsDraft<V, R> {
  return { rows: toRows(value), seen: value, lastPublished: undefined };
}

/** Reseeds the rows when the configured value changes from outside this editor. */
export function reconcileRowsDraft<V, R>(
  draft: RowsDraft<V, R>,
  incoming: V,
  equal: (left: V, right: V) => boolean,
  toRows: (value: V) => ReadonlyArray<R>,
): RowsDraft<V, R> {
  if (draft.seen === incoming || equal(draft.seen, incoming)) return draft;
  const echo = draft.lastPublished !== undefined && equal(draft.lastPublished, incoming);
  return { rows: echo ? draft.rows : toRows(incoming), seen: incoming, lastPublished: undefined };
}
