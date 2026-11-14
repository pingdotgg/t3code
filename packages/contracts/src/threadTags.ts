import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Tags are trimmed and match ignoring case; a thread keeps the spelling it was first tagged with. */
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

/** The identity tag spellings share: "bug" and "Bug" are one tag. */
export const threadTagKey = (tag: string): string => tag.toLowerCase();

/** Tagging keeps an existing spelling; untagging removes every spelling. Returns `tags` when unchanged. */
export function applyThreadTag(
  tags: ReadonlyArray<string>,
  tag: string,
  tagged: boolean,
): ReadonlyArray<string> {
  const key = threadTagKey(tag);
  if (tagged) return tags.some((each) => threadTagKey(each) === key) ? tags : [...tags, tag];
  const kept = tags.filter((each) => threadTagKey(each) !== key);
  return kept.length === tags.length ? tags : kept;
}
