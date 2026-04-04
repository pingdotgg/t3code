import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas";

export const VaultSecretId = TrimmedNonEmptyString.pipe(Schema.brand("VaultSecretId"));
export type VaultSecretId = typeof VaultSecretId.Type;

export const VaultVariableId = TrimmedNonEmptyString.pipe(Schema.brand("VaultVariableId"));
export type VaultVariableId = typeof VaultVariableId.Type;

export const VaultVariable = Schema.Struct({
  id: VaultVariableId,
  key: TrimmedNonEmptyString,
  value: TrimmedNonEmptyString,
});
export type VaultVariable = typeof VaultVariable.Type;

export const VaultSecretSummary = Schema.Struct({
  id: VaultSecretId,
  key: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});
export type VaultSecretSummary = typeof VaultSecretSummary.Type;

export const VaultSecretsSnapshot = Schema.Struct({
  enabled: Schema.Boolean,
  safeStorageAvailable: Schema.Boolean,
  message: Schema.NullOr(TrimmedString),
  secrets: Schema.Array(VaultSecretSummary),
});
export type VaultSecretsSnapshot = typeof VaultSecretsSnapshot.Type;

export const VaultSecretUpsertInput = Schema.Struct({
  id: Schema.optional(VaultSecretId),
  key: TrimmedNonEmptyString,
  value: Schema.optional(TrimmedNonEmptyString),
});
export type VaultSecretUpsertInput = typeof VaultSecretUpsertInput.Type;

export const VaultSecretDeleteInput = Schema.Struct({
  id: VaultSecretId,
});
export type VaultSecretDeleteInput = typeof VaultSecretDeleteInput.Type;
