import type { EnvironmentId, OrchestrationGetTurnDiffResult, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

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
    registry.set(atom, { ...current, [value.toTurnCount]: value.diff });
  });
