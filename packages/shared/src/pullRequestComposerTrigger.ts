import { replaceTextRange } from "./composerTrigger.ts";

export interface PullRequestComposerTrigger {
  readonly kind: "mention" | "reference";
  /** `@` for a mention; `#` or `!` (GitLab merge requests) for a reference. */
  readonly sigil: "@" | "#" | "!";
  readonly query: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
}

// Mentions cover GitHub logins (letters, digits, hyphens) and GitLab usernames (also `_` and `.`).
const TOKEN = /^(?:@([A-Za-z0-9_][A-Za-z0-9_.-]*)?|([#!])([\p{L}\p{N}_-]*))$/u;

/** The `@login`, `#123` or `!123` being typed at the caret, when the caret sits at its end. */
export function detectPullRequestComposerTrigger(
  text: string,
  cursor: number,
): PullRequestComposerTrigger | null {
  const end = Math.max(0, Math.min(text.length, cursor));
  const next = text[end];
  if (next !== undefined && !/\s/.test(next)) return null;
  let start = end;
  while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start -= 1;
  const match = TOKEN.exec(text.slice(start, end));
  if (!match) return null;
  const sigil = match[2];
  return sigil === "#" || sigil === "!"
    ? { kind: "reference", sigil, query: match[3] ?? "", rangeStart: start, rangeEnd: end }
    : { kind: "mention", sigil: "@", query: match[1] ?? "", rangeStart: start, rangeEnd: end };
}

/** Replaces the trigger with `token` and leaves the caret past the space after it. */
export function insertPullRequestCompletion(
  text: string,
  trigger: PullRequestComposerTrigger,
  token: string,
): { text: string; cursor: number } {
  const followedBySpace = /[ \t]/.test(text[trigger.rangeEnd] ?? "");
  if (!followedBySpace) {
    return replaceTextRange(text, trigger.rangeStart, trigger.rangeEnd, `${token} `);
  }
  const inserted = replaceTextRange(text, trigger.rangeStart, trigger.rangeEnd, token);
  return { ...inserted, cursor: inserted.cursor + 1 };
}

// GitLab's user, issue and merge request searches answer nothing below three characters, so
// shorter text narrows the unsearched list locally instead. A number is looked up as typed.
const MIN_HOST_SEARCH = 3;

/** The search to send the host for what follows the trigger's sigil, if any. */
export function pullRequestCompletionSearch(
  trigger: Pick<PullRequestComposerTrigger, "kind" | "query">,
): string | undefined {
  const query = trigger.query.slice(0, 100);
  if (trigger.kind === "reference" && /^\d+$/.test(query)) return query;
  return query.length >= MIN_HOST_SEARCH ? query : undefined;
}

/** The key a debounce delays: the trigger's kind and its host search, or `null` with no trigger. */
export function pullRequestCompletionKey(
  trigger: Pick<PullRequestComposerTrigger, "kind" | "query"> | null,
): string | null {
  return trigger === null ? null : `${trigger.kind}:${pullRequestCompletionSearch(trigger) ?? ""}`;
}

/**
 * The search to send for `trigger` given a debounced key. Until a key for this kind settles, the
 * host is asked for its unsearched list, which narrows locally, so a burst of typing sends one query.
 */
export function debouncedPullRequestCompletionSearch(
  trigger: Pick<PullRequestComposerTrigger, "kind" | "query">,
  debouncedKey: string | null,
): string | undefined {
  const prefix = `${trigger.kind}:`;
  return debouncedKey?.startsWith(prefix)
    ? debouncedKey.slice(prefix.length) || undefined
    : undefined;
}

export function narrowPullRequestMentions<A extends { login: string; name: string | null }>(
  users: ReadonlyArray<A>,
  typed: string,
  limit: number,
): A[] {
  const needle = typed.toLowerCase();
  return users
    .filter(
      (user) =>
        user.login.toLowerCase().includes(needle) ||
        (user.name?.toLowerCase().includes(needle) ?? false),
    )
    .slice(0, limit);
}

/** Candidates the typed sigil links, by number prefix or title. */
export function narrowPullRequestReferences<
  A extends { reference: string; number: number; title: string },
>(
  candidates: ReadonlyArray<A>,
  trigger: Pick<PullRequestComposerTrigger, "sigil" | "query">,
  limit: number,
): A[] {
  const needle = trigger.query.toLowerCase();
  return candidates
    .filter(
      (candidate) =>
        candidate.reference.startsWith(trigger.sigil) &&
        (String(candidate.number).startsWith(needle) ||
          candidate.title.toLowerCase().includes(needle)),
    )
    .slice(0, limit);
}
