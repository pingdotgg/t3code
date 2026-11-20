import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Tags match by exact spelling and case after trimming. */
export const ThreadTag = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value) =>
    /[\p{Cc}]/u.test(value) ? "A thread tag must be a single line of text." : true,
  ),
);
export type ThreadTag = typeof ThreadTag.Type;

/** Tags read back from storage or a peer. Lenient so a later tag rule never fails a whole thread. */
export const StoredThreadTags = Schema.Array(Schema.String).pipe(
  Schema.catchDecoding(() => Effect.succeedSome([])),
);

/** Built-in tag for threads moved out of the main sidebar into the Hidden section below Settled. */
export const SIDEBAR_HIDDEN_THREAD_TAG: ThreadTag = "hidden";
export const SCHEDULED_TASK_HIDDEN_THREAD_TAG: ThreadTag = "scheduled-task-hidden";

export function isSidebarHiddenThread(thread: {
  readonly tags?: ReadonlyArray<string> | undefined;
}): boolean {
  return (
    thread.tags?.includes(SIDEBAR_HIDDEN_THREAD_TAG) === true ||
    thread.tags?.includes(SCHEDULED_TASK_HIDDEN_THREAD_TAG) === true
  );
}
