import { replaceTextRange } from "./composerTrigger.ts";

export interface PullRequestMentionTrigger {
  readonly query: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
}

// Covers GitHub logins (letters, digits, hyphens) and GitLab usernames (also `_` and `.`).
const MENTION_TOKEN = /^@([A-Za-z0-9_][A-Za-z0-9_.-]*)?$/;

/** The `@login` being typed at the caret, when the caret sits at its end. */
export function detectPullRequestMention(
  text: string,
  cursor: number,
): PullRequestMentionTrigger | null {
  const end = Math.max(0, Math.min(text.length, cursor));
  const next = text[end];
  if (next !== undefined && !/\s/.test(next)) return null;
  let start = end;
  while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start -= 1;
  const match = MENTION_TOKEN.exec(text.slice(start, end));
  if (!match) return null;
  return { query: match[1] ?? "", rangeStart: start, rangeEnd: end };
}

export function insertPullRequestMention(
  text: string,
  trigger: PullRequestMentionTrigger,
  login: string,
): { text: string; cursor: number } {
  const followedBySpace = /[ \t]/.test(text[trigger.rangeEnd] ?? "");
  if (!followedBySpace) {
    return replaceTextRange(text, trigger.rangeStart, trigger.rangeEnd, `@${login} `);
  }
  const inserted = replaceTextRange(text, trigger.rangeStart, trigger.rangeEnd, `@${login}`);
  return { ...inserted, cursor: inserted.cursor + 1 };
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
