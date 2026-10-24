import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

const COMPOSER_THREAD_RESULT_LIMIT = 5;

export interface ComposerThreadCandidate {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
}

/**
 * The agent can only read threads on its own server, so candidates stay within the
 * composer's environment.
 */
export function matchComposerThreadItems(input: {
  shells: ReadonlyArray<ComposerThreadCandidate>;
  environmentId: EnvironmentId;
  excludeThreadId: ThreadId | null;
  query: string;
}): ComposerThreadItem[] {
  const pastedId = input.query.trim();
  const query = pastedId.toLowerCase();
  if (query.length === 0) return [];
  return input.shells
    .filter(
      (shell) =>
        shell.environmentId === input.environmentId &&
        shell.id !== input.excludeThreadId &&
        shell.archivedAt === null &&
        // Thread IDs share long prefixes and are case-sensitive, so only the exact ID matches.
        (shell.title.toLowerCase().includes(query) || shell.id === pastedId),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, COMPOSER_THREAD_RESULT_LIMIT)
    .map((shell) => ({
      id: `thread:${shell.environmentId}:${shell.id}`,
      type: "thread",
      thread: { environmentId: shell.environmentId, threadId: shell.id },
      label: shell.title,
      description: "Thread",
    }));
}
