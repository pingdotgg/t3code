import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface CheckpointDiffTarget {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly fromTurnCount: number | null;
  readonly toTurnCount: number | null;
  readonly ignoreWhitespace: boolean;
}

export interface ComposerPathSearchTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly query: string | null;
}

export function normalizeComposerPathSearchQuery(query: string | null): string | null {
  return query?.trim() ?? null;
}

/** Whether a path search ran for this environment, directory and normalized query. */
export function isComposerPathSearchTarget(
  searched: ComposerPathSearchTarget,
  current: ComposerPathSearchTarget,
): boolean {
  return (
    searched.environmentId === current.environmentId &&
    searched.cwd === current.cwd &&
    searched.query === normalizeComposerPathSearchQuery(current.query)
  );
}

export function buildCheckpointDiffTargets(target: CheckpointDiffTarget) {
  if (
    target.environmentId === null ||
    target.threadId === null ||
    target.fromTurnCount === null ||
    target.toTurnCount === null
  ) {
    return { fullThread: null, turn: null } as const;
  }

  if (target.fromTurnCount === 0) {
    return {
      fullThread: {
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          toTurnCount: target.toTurnCount,
          ignoreWhitespace: target.ignoreWhitespace,
        },
      },
      turn: null,
    } as const;
  }

  return {
    fullThread: null,
    turn: {
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        fromTurnCount: target.fromTurnCount,
        toTurnCount: target.toTurnCount,
        ignoreWhitespace: target.ignoreWhitespace,
      },
    },
  } as const;
}
