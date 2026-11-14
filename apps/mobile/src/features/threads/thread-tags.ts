import {
  filterThreadsByTag,
  suggestThreadTags,
} from "@t3tools/client-runtime/state/threadTagFilter";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

const MAX_VISIBLE_TAGS = 2;

/** Filters the full shell list so a tagged subagent keeps its parent row, then keeps only the listed rows. */
export function filterListedThreadsByTag(
  listed: ReadonlyArray<EnvironmentThreadShell>,
  all: ReadonlyArray<EnvironmentThreadShell>,
  tag: string | null,
): ReadonlyArray<EnvironmentThreadShell> {
  if (tag === null) return listed;
  const keyOf = (thread: EnvironmentThreadShell) =>
    threadKey({ environmentId: thread.environmentId, threadId: thread.id });
  const kept = new Set(filterThreadsByTag(all, [tag]).map(keyOf));
  return listed.filter((thread) => kept.has(keyOf(thread)));
}

export function visibleThreadTags(tags: ReadonlyArray<string> | undefined) {
  const all = tags ?? [];
  return {
    shown: all.slice(0, MAX_VISIBLE_TAGS),
    overflow: Math.max(0, all.length - MAX_VISIBLE_TAGS),
  };
}

export function formatThreadTagsLabel(tags: ReadonlyArray<string> | undefined): string | null {
  const { shown, overflow } = visibleThreadTags(tags);
  if (shown.length === 0) return null;
  return shown.join(", ") + (overflow > 0 ? ` +${overflow}` : "");
}

/** Checked tags first, then the other known tags, both narrowed by the query. */
export function threadTagPickerRows(
  known: ReadonlyArray<string>,
  own: ReadonlyArray<string>,
  query: string,
): ReadonlyArray<string> {
  const needle = query.trim().toLowerCase();
  const checked = own
    .filter((tag) => needle === "" || tag.toLowerCase().includes(needle))
    .sort((left, right) => left.localeCompare(right));
  return [...checked, ...suggestThreadTags(known, own, query)];
}
