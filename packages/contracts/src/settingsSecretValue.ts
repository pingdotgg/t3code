import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

import { TrimmedString } from "./baseSchemas.ts";
import { SecretReference } from "./secretReference.ts";

/**
 * A credential setting: the literal, which is kept in the secret store and redacted for
 * clients, or the secret reference to read it from, which is not itself a secret and is
 * stored and shown as written. Typing a settings field with it is the whole declaration:
 * forms offer a secret provider for it and the server reads the secret for its consumer.
 */
export const SettingsSecretValue = Schema.Union([TrimmedString, SecretReference]).pipe(
  Schema.annotateKey({ settingsSecret: true, settingsSecretReference: true }),
);
export type SettingsSecretValue = typeof SettingsSecretValue.Type;

export const isSecretReference = Schema.is(SecretReference);

/** The literal a credential setting holds, or `""` when it names a secret instead. */
export function settingsSecretLiteral(value: SettingsSecretValue | undefined): string {
  return typeof value === "string" ? value : "";
}

export function acceptsSecretReference(schema: Schema.Top): boolean {
  return Schema.resolveAnnotationsKey(schema)?.settingsSecretReference === true;
}

const declaresSecretReference = (ast: SchemaAST.AST) =>
  ast.context?.annotations?.settingsSecretReference === true;

interface SecretReferenceField {
  readonly field: string;
  readonly keyed: boolean;
}

/**
 * Fields of a settings struct typed `SettingsSecretValue`, or a record of it such as one value
 * per host; any other schema has none.
 */
function secretReferenceSettingsFields(schema: Schema.Top): ReadonlyArray<SecretReferenceField> {
  if (!SchemaAST.isObjects(schema.ast)) return [];
  return schema.ast.propertySignatures.flatMap<SecretReferenceField>(({ name, type }) => {
    if (typeof name !== "string") return [];
    if (declaresSecretReference(type)) return [{ field: name, keyed: false }];
    return SchemaAST.isObjects(type) &&
      type.indexSignatures.some((signature) => declaresSecretReference(signature.type))
      ? [{ field: name, keyed: true }]
      : [];
  });
}

/** Where a reference sits: a field, or one key of a record field. */
export interface SettingsSecretSlot {
  readonly field: string;
  readonly key: string | undefined;
}

interface SettingsSecretReference extends SettingsSecretSlot {
  readonly reference: SecretReference;
}

/** Each declared reference slot of `settings` that holds a reference, in field order. */
export function secretReferencesInSettings(
  schema: Schema.Top,
  settings: unknown,
): ReadonlyArray<SettingsSecretReference> {
  if (settings === null || typeof settings !== "object") return [];
  const values = settings as Readonly<Record<string, unknown>>;
  return secretReferenceSettingsFields(schema).flatMap<SettingsSecretReference>(
    ({ field, keyed }) => {
      const value = values[field];
      if (!keyed)
        return isSecretReference(value) ? [{ field, key: undefined, reference: value }] : [];
      if (value === null || typeof value !== "object") return [];
      return Object.entries(value).flatMap(([key, entry]) =>
        isSecretReference(entry) ? [{ field, key, reference: entry }] : [],
      );
    },
  );
}

/** `settings` with each slot set to its value, keeping the other keys of a record field. */
export function withSettingsSecrets<Settings extends Readonly<Record<string, unknown>>>(
  settings: Settings,
  slots: ReadonlyArray<SettingsSecretSlot & { readonly value: string }>,
): Settings {
  const next: Record<string, unknown> = { ...settings };
  for (const { field, key, value } of slots) {
    next[field] = key === undefined ? value : { ...(next[field] as object), [key]: value };
  }
  return next as Settings;
}
