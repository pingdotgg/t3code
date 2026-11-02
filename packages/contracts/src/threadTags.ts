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

export const ThreadTags = Schema.Array(ThreadTag);

/** Which tagged threads clients hide. `only` keeps just the threads carrying one of its tags. */
export const ThreadTagFilter = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  hide: ThreadTags.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  only: ThreadTags.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ThreadTagFilter = typeof ThreadTagFilter.Type;

export const DEFAULT_THREAD_TAG_FILTER: ThreadTagFilter = Schema.decodeSync(ThreadTagFilter)({});

export function isThreadHiddenByTagFilter(
  tags: ReadonlyArray<string> | null | undefined,
  filter: ThreadTagFilter | null | undefined,
): boolean {
  if (!filter?.enabled) return false;
  const threadTags = tags ?? [];
  if (filter.hide.some((tag) => threadTags.includes(tag))) return true;
  return filter.only.length > 0 && !filter.only.some((tag) => threadTags.includes(tag));
}
