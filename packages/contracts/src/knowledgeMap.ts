import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

const Topic = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
);
const Explanation = Schema.String.check(Schema.isMaxLength(600));
const BuildsOn = Schema.Array(Topic).check(
  Schema.makeFilter((value: readonly unknown[]) => value.length <= 8, {
    message: "at most 8 items",
  }),
);

export const KnowledgeMapEntry = Schema.Struct({
  topic: Topic,
  explanation: Explanation,
  buildsOn: BuildsOn,
  doneAt: Schema.String,
  threadId: ThreadId,
});
export type KnowledgeMapEntry = typeof KnowledgeMapEntry.Type;
export const KnowledgeMapEntries = Schema.Array(KnowledgeMapEntry);

export const KnowledgeMapMarkDoneInput = Schema.Struct({
  topic: Topic,
  explanation: Explanation,
  buildsOn: Schema.optional(BuildsOn),
});
export type KnowledgeMapMarkDoneInput = typeof KnowledgeMapMarkDoneInput.Type;

export const KnowledgeMapRemoveInput = Schema.Struct({ topic: Topic });
export type KnowledgeMapRemoveInput = typeof KnowledgeMapRemoveInput.Type;

export class KnowledgeMapError extends Schema.TaggedError<KnowledgeMapError>()(
  "KnowledgeMapError",
  {
    message: Schema.String,
  },
) {}
