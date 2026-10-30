import { SecretProviderKind } from "@t3tools/contracts";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as Schema from "effect/Schema";

const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Any value `op --account` accepts: shorthand, sign-in address, account ID, or user ID.
 * It is passed to the CLI as an argument, so it can never start with `-`.
 */
export const OnePasswordAccount = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.makeFilter((value: string) =>
    ACCOUNT_PATTERN.test(value)
      ? true
      : "1Password account must be a shorthand, sign-in address, or ID with no spaces.",
  ),
).pipe(Schema.brand("OnePasswordAccount"));
export type OnePasswordAccount = typeof OnePasswordAccount.Type;

export const OnePasswordSecretProviderConfig = Schema.Struct({
  account: OnePasswordAccount,
});
export type OnePasswordSecretProviderConfig = typeof OnePasswordSecretProviderConfig.Type;

// 1Password secret reference syntax: names outside this charset must be written as item ids.
// It also keeps `{{`, `}}`, and line breaks out of the `op inject` template the server builds.
const NAME = String.raw`[A-Za-z0-9._-](?:[A-Za-z0-9 ._-]*[A-Za-z0-9._-])?`;
const REFERENCE = new RegExp(
  String.raw`^op://${NAME}(?:/${NAME}){2,3}(?:\?[a-z-]+=[A-Za-z0-9_-]+)?$`,
);
const MAX_REFERENCE_LENGTH = 1024;

export const definition = defineSecretProvider({
  kind: SecretProviderKind.make("one_password"),
  label: "1Password",
  configSchema: OnePasswordSecretProviderConfig,
  isReference: (reference) => reference.length <= MAX_REFERENCE_LENGTH && REFERENCE.test(reference),
  referencePlaceholder: "op://vault/item/field",
  invalidReferenceMessage: "Use a 1Password reference like op://vault/item/field.",
});
