import type { EnvironmentId, OrchestrationGetTurnDiffResult, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import {
  MAX_CACHED_REVIEW_DIFFS,
  MAX_CACHED_REVIEW_SOURCE_CHARACTERS,
} from "../features/review/reviewState";

const EMPTY_TURN_DIFFS = Object.freeze<Readonly<Record<number, string>>>({});

// The last answered diff of each single turn, keyed by its turn count, so review keeps showing
// turns it already loaded while the environment is disconnected and no turn query is mounted.
const lastTurnDiffsFamily = Atom.family((key: string) =>
  Atom.make(EMPTY_TURN_DIFFS).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:turn-diffs:${key}`),
  ),
);

export function lastReviewTurnDiffsAtom(environmentId: EnvironmentId, threadId: ThreadId) {
  return lastTurnDiffsFamily(JSON.stringify([environmentId, threadId]));
}

// Integer keys enumerate in ascending order, so the lowest turn counts are evicted first.
const pruneTurnDiffs = (diffs: Readonly<Record<number, string>>) => {
  const turnCounts = Object.keys(diffs).map((key) => Number(key));
  let characters = turnCounts.reduce(
    (total, turnCount) => total + (diffs[turnCount]?.length ?? 0),
    0,
  );
  let dropped = 0;
  while (
    turnCounts.length - dropped > MAX_CACHED_REVIEW_DIFFS ||
    characters > MAX_CACHED_REVIEW_SOURCE_CHARACTERS
  ) {
    const oldest = turnCounts[dropped];
    if (oldest === undefined) break;
    characters -= diffs[oldest]?.length ?? 0;
    dropped += 1;
  }
  if (dropped === 0) return diffs;
  const kept: Record<number, string> = { ...diffs };
  for (const turnCount of turnCounts.slice(0, dropped)) {
    delete kept[turnCount];
  }
  return kept;
};

export const recordReviewTurnDiffAnswer = (
  target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly ignoreWhitespace?: boolean };
  },
  value: OrchestrationGetTurnDiffResult,
  registry: AtomRegistry.AtomRegistry,
) =>
  Effect.sync(() => {
    // Review shows one turn with whitespace changes; other ranges and whitespace-ignoring
    // reads are not what a review section displays.
    if (target.input.ignoreWhitespace === true || value.fromTurnCount !== value.toTurnCount - 1) {
      return;
    }
    const atom = lastReviewTurnDiffsAtom(target.environmentId, value.threadId);
    const current = registry.get(atom);
    if (current[value.toTurnCount] === value.diff) return;
    registry.set(atom, pruneTurnDiffs({ ...current, [value.toTurnCount]: value.diff }));
  });
