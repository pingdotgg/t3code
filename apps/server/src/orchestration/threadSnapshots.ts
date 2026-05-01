import {
  type OrchestrationGetSnapshotError,
  type OrchestrationThread,
  type ThreadId,
} from "@forma/contracts";
import { Duration, Effect, Option } from "effect";

export function waitForThreadDetailSnapshot(input: {
  threadId: ThreadId;
  getThreadDetailById: () => Effect.Effect<
    Option.Option<OrchestrationThread>,
    OrchestrationGetSnapshotError
  >;
  getSnapshotSequence: () => Effect.Effect<number, never>;
  pollIntervalMs?: number;
}): Effect.Effect<
  {
    snapshotSequence: number;
    thread: OrchestrationThread;
  },
  OrchestrationGetSnapshotError
> {
  const pollIntervalMs = input.pollIntervalMs ?? 25;

  return Effect.gen(function* () {
    for (;;) {
      const [threadDetail, snapshotSequence] = yield* Effect.all([
        input.getThreadDetailById(),
        input.getSnapshotSequence(),
      ]);

      if (Option.isSome(threadDetail)) {
        return {
          snapshotSequence,
          thread: threadDetail.value,
        };
      }

      yield* Effect.sleep(Duration.millis(pollIntervalMs));
    }
  });
}
