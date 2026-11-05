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

/** Fields of a settings struct typed `SettingsSecretValue`; any other schema has none. */
function secretReferenceSettingsFields(schema: Schema.Top): ReadonlyArray<string> {
  if (!SchemaAST.isObjects(schema.ast)) return [];
  return schema.ast.propertySignatures.flatMap((property) =>
    property.type.context?.annotations?.settingsSecretReference === true &&
    typeof property.name === "string"
      ? [property.name]
      : [],
  );
}

/** Each declared reference field of `settings` that holds a reference, in field order. */
export function secretReferencesInSettings(
  schema: Schema.Top,
  settings: unknown,
): ReadonlyArray<{ readonly field: string; readonly reference: SecretReference }> {
  if (settings === null || typeof settings !== "object") return [];
  const values = settings as Readonly<Record<string, unknown>>;
  return secretReferenceSettingsFields(schema).flatMap((field) => {
    const value = values[field];
    return isSecretReference(value) ? [{ field, reference: value }] : [];
  });
}
