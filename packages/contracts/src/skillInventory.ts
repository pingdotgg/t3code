import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * Filesystem inventory intentionally omits per-skill enablement. Codex only
 * exposes that state through its live RPC, while Claude has no equivalent,
 * so persisting it here would make the cross-harness response misleading.
 */
export const SkillInventoryInstallation = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  harness: ProviderDriverKind,
  harnessDisplayName: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  directoryPath: TrimmedNonEmptyString,
  skillFilePath: TrimmedNonEmptyString,
  content: Schema.String,
});
export type SkillInventoryInstallation = typeof SkillInventoryInstallation.Type;

export const SkillInventory = Schema.Struct({
  scannedAt: TrimmedNonEmptyString,
  installations: Schema.Array(SkillInventoryInstallation),
});
export type SkillInventory = typeof SkillInventory.Type;
