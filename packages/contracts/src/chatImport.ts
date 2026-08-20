import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const LocalChatImportPlatform = Schema.Literals(["codex", "opencode"]);
export type LocalChatImportPlatform = typeof LocalChatImportPlatform.Type;

export const LocalChatImportInput = Schema.Struct({
  platform: LocalChatImportPlatform,
  instanceId: Schema.optionalKey(ProviderInstanceId),
});
export type LocalChatImportInput = typeof LocalChatImportInput.Type;

export const LocalChatImportResult = Schema.Struct({
  discovered: NonNegativeInt,
  imported: NonNegativeInt,
  skipped: NonNegativeInt,
  failed: NonNegativeInt,
});
export type LocalChatImportResult = typeof LocalChatImportResult.Type;

export class LocalChatImportError extends Schema.TaggedErrorClass<LocalChatImportError>()(
  "LocalChatImportError",
  {
    platform: LocalChatImportPlatform,
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const label = this.platform === "codex" ? "Codex" : "OpenCode";
    return `${label} chat import failed: ${this.reason}`;
  }
}
