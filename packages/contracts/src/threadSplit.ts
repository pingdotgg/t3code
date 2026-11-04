import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";
export const ThreadSplitSuggestionInput = Schema.Struct({
  threadId: ThreadId,
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(12000)),
});
export type ThreadSplitSuggestionInput = typeof ThreadSplitSuggestionInput.Type;
export const ThreadSplitSuggestionResult = Schema.Struct({ suggest: Schema.Boolean });
export type ThreadSplitSuggestionResult = typeof ThreadSplitSuggestionResult.Type;
