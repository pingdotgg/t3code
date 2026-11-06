import type { EnvironmentId } from "@t3tools/contracts";
import {
  type FleetDrainExecutor as FleetDrainExecutorPort,
  type FleetDrainOutcome,
} from "@t3tools/openshell/OpenShellGatewayDriver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Nothing is deleted until its data is here (spec section 7): per-thread copies
 * read back for verification, checkout pushes, per-item acks keyed by drain id.
 */
export class FleetDrainStepError extends Schema.TaggedError<FleetDrainStepError>()(
  "FleetDrainStepError",
  {
    step: Schema.Literals(["shell", "thread", "history", "write", "read", "push"]),
    message: Schema.String,
  },
) {}

export class FleetDrainError extends Schema.TaggedError<FleetDrainError>()("FleetDrainError", {
  environmentId: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Where a drain writes: one directory per run, one file per thread. */
export interface DrainSink {
  readonly write: (input: {
    readonly environmentId: EnvironmentId;
    readonly drainId: string;
    readonly threadId: string;
    readonly body: string;
  }) => Effect.Effect<{ readonly bytes: number }, FleetDrainStepError>;
  readonly read: (input: {
    readonly environmentId: EnvironmentId;
    readonly drainId: string;
    readonly threadId: string;
  }) => Effect.Effect<string | null, FleetDrainStepError>;
}

/** Pushes one checkout and its checkpoint refs to the remote it already has. */
export interface DrainGitPush {
  readonly push: (input: {
    readonly environmentId: EnvironmentId;
    readonly sandboxName: string;
    readonly workspaceRoot: string;
  }) => Effect.Effect<{ readonly exitCode: number; readonly stderr: string }, FleetDrainStepError>;
}

/** The worker's own view of what it holds, read over its authenticated link. */
export interface DrainSource {
  readonly shell: (environmentId: EnvironmentId) => Effect.Effect<
    {
      readonly threads: ReadonlyArray<{ readonly threadId: string }>;
      readonly projects: ReadonlyArray<{ readonly workspaceRoot: string }>;
    },
    FleetDrainStepError
  >;
  readonly threadHistory: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: string;
  }) => Effect.Effect<{ readonly body: string }, FleetDrainStepError>;
}

export interface DrainDependencies {
  readonly source: DrainSource;
  readonly sink: DrainSink;
  readonly git: DrainGitPush;
  readonly now: Effect.Effect<number>;
}

export interface DrainInput {
  readonly environmentId: EnvironmentId;
  readonly sandboxName: string;
  readonly drainId: string;
  readonly snapshotOnly: boolean;
  readonly deadlineAt: number;
}

export interface DrainExecutorShape {
  readonly drain: (input: DrainInput) => Effect.Effect<FleetDrainOutcome, FleetDrainError>;
}

const zero = () => ({ total: 0, acked: 0, failed: 0 });

const reported = (outcome: FleetDrainOutcome): FleetDrainOutcome => outcome;

/**
 * Drains one worker. Every step is keyed by `drainId` and per item, so a retry
 * after a crash re-reads what already landed instead of fetching it again.
 */
export const makeDrainExecutor = (deps: DrainDependencies): DrainExecutorShape => {
  const drain = Effect.fn("FleetDrainExecutor.drain")(function* (input: DrainInput) {
    const threads = zero();
    const worktrees = zero();
    let failure: string | undefined;
    let deadlineHit = false;
    const shell = yield* deps.source.shell(input.environmentId).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          failure = cause.message;
          return { threads: [], projects: [] };
        }),
      ),
    );
    for (const thread of shell.threads) {
      if ((yield* deps.now) >= input.deadlineAt) {
        failure = "The drain deadline passed before every thread was copied.";
        deadlineHit = true;
        break;
      }
      threads.total += 1;
      const copied = yield* Effect.gen(function* () {
        const already = yield* deps.sink.read({
          environmentId: input.environmentId,
          drainId: input.drainId,
          threadId: thread.threadId,
        });
        if (already !== null) return true;
        const history = yield* deps.source.threadHistory({
          environmentId: input.environmentId,
          threadId: thread.threadId,
        });
        const written = yield* deps.sink.write({
          environmentId: input.environmentId,
          drainId: input.drainId,
          threadId: thread.threadId,
          body: history.body,
        });
        // Read it back: an ack means the bytes are here, not that a write was attempted.
        const back = yield* deps.sink.read({
          environmentId: input.environmentId,
          drainId: input.drainId,
          threadId: thread.threadId,
        });
        return back === history.body && written.bytes > 0;
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            failure = cause.message;
            return false;
          }),
        ),
      );
      if (copied) threads.acked += 1;
      else threads.failed += 1;
    }
    // A forced removal still ships the threads, which are the part that cannot be rebuilt.
    if (!input.snapshotOnly) {
      for (const project of shell.projects) {
        if ((yield* deps.now) >= input.deadlineAt) {
          failure = "The drain deadline passed before every checkout was pushed.";
          deadlineHit = true;
          break;
        }
        worktrees.total += 1;
        const pushed = yield* deps.git
          .push({
            environmentId: input.environmentId,
            sandboxName: input.sandboxName,
            workspaceRoot: project.workspaceRoot,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.sync(() => {
                failure = cause.message;
                return { exitCode: 1, stderr: failure ?? "" };
              }),
            ),
          );
        if (pushed.exitCode === 0) worktrees.acked += 1;
        else {
          worktrees.failed += 1;
          if (failure === undefined) failure = pushed.stderr.trim() || "A checkout was not pushed.";
        }
      }
    }
    // A deadline that cut the run short is never an ack, even with no failures.
    const complete = !deadlineHit && threads.failed === 0 && worktrees.failed === 0;
    return reported({
      threads,
      worktrees,
      state: complete ? "acked" : "failed",
      finishedAt: complete ? yield* deps.now : null,
    });
  });

  return { drain };
};

/** The OpenShell driver calls the drain Promise-shaped, during removal. */
export const asDriverPort = (
  executor: DrainExecutorShape,
  runPromise: <A>(effect: Effect.Effect<A, FleetDrainStepError>) => Promise<A>,
): FleetDrainExecutorPort => ({
  drain: (input) =>
    runPromise(
      executor
        .drain({
          environmentId: input.environmentId,
          sandboxName: input.sandboxName,
          drainId: input.drainId,
          snapshotOnly: input.snapshotOnly,
          deadlineAt: input.deadlineAt,
        })
        .pipe(
          Effect.orElseSucceed((): FleetDrainOutcome => ({
            threads: zero(),
            worktrees: zero(),
            state: "failed",
            finishedAt: null,
          })),
        ),
    ),
});
