import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

interface RunningTerminalSummary {
  readonly hasRunningSubprocess: boolean;
  readonly threadId: string;
}

export function createRunningTerminalState<Summary extends RunningTerminalSummary, E>(input: {
  readonly getMetadataAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<Summary>, E>>;
}) {
  const runningThreadIdsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const summaries = Option.getOrElse(
        AsyncResult.value(get(input.getMetadataAtom(environmentId))),
        () => [],
      );
      const threadIds = new Set<string>();

      for (const summary of summaries) {
        if (summary.hasRunningSubprocess) {
          threadIds.add(summary.threadId);
        }
      }

      return threadIds;
    }).pipe(Atom.withLabel(`mobile-running-terminal-threads:${environmentId}`)),
  );

  const threadHasRunningTerminalAtom = Atom.family((key: string) => {
    const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
    return Atom.make((get) => get(runningThreadIdsAtom(environmentId)).has(threadId)).pipe(
      Atom.withLabel(`mobile-thread-has-running-terminal:${key}`),
    );
  });

  return {
    threadHasRunningTerminalAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      threadHasRunningTerminalAtom(JSON.stringify([environmentId, threadId])),
  };
}
