import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const HermesImportSessionsInput = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
});
export type HermesImportSessionsInput = typeof HermesImportSessionsInput.Type;

export const HermesImportSessionsResult = Schema.Struct({
  discovered: NonNegativeInt,
  imported: NonNegativeInt,
  removedSubagents: NonNegativeInt,
  skipped: NonNegativeInt,
  failed: NonNegativeInt,
});
export type HermesImportSessionsResult = typeof HermesImportSessionsResult.Type;

export class HermesImportSessionsError extends Schema.TaggedErrorClass<HermesImportSessionsError>()(
  "HermesImportSessionsError",
  {
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Hermes chat import failed: ${this.reason}`;
  }
}
