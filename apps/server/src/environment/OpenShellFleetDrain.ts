import type { EnvironmentId } from "@t3tools/contracts";
import {
  type FleetDrainExecutor as FleetDrainExecutorPort,
  type FleetDrainOutcome,
} from "@t3tools/openshell/OpenShellGatewayDriver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Nothing is deleted until its data is here (spec section 7): per-thread copies
 * read back for verification, checkout bundle exports, per-item acks keyed by
 * drain id.
 */
export class FleetDrainStepError extends Schema.TaggedError<
  FleetDrainStepError,
  { readonly brand: unique symbol }
>()("FleetDrainStepError", {
  step: Schema.Literals(["shell", "thread", "history", "write", "read", "bundle", "attachments"]),
  message: Schema.String,
}) {}

export class FleetDrainError extends Schema.TaggedError<
  FleetDrainError,
  { readonly brand: unique symbol }
>()("FleetDrainError", {
  environmentId: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** One stored thread copy plus the currency marker that decides trust on a retry. */
export interface DrainSinkRecord {
  readonly threadId: string;
  readonly snapshotSequence: number | null;
  readonly body: string;
  /** Manifest of the attachment files stored next to the bundle, if any. */
  readonly attachments?: ReadonlyArray<DrainAttachmentManifestEntry>;
  /** True when the worker's attachments exceeded the drain's size cap. */
  readonly attachmentsSkipped?: boolean;
}

/** One attachment file in a bundle, base64-encoded. */
export interface DrainAttachmentFile {
  readonly name: string;
  readonly bytes: string;
}

export interface DrainAttachmentManifestEntry {
  readonly name: string;
  readonly hash: string;
  readonly size: number;
}

/** A thread's attachment files as the worker holds them, plus cap outcome. */
export interface DrainAttachments {
  readonly files: ReadonlyArray<DrainAttachmentFile>;
  readonly oversizeSkipped: boolean;
}

/** Where a drain writes: one directory per run, one file per thread. */
export interface DrainSink {
  readonly write: (input: {
    readonly environmentId: EnvironmentId;
    readonly drainId: string;
    readonly threadId: string;
    readonly body: string;
    readonly snapshotSequence: number | null;
    readonly attachments?: DrainAttachments;
  }) => Effect.Effect<{ readonly bytes: number }, FleetDrainStepError>;
  readonly read: (input: {
    readonly environmentId: EnvironmentId;
    readonly drainId: string;
    readonly threadId: string;
  }) => Effect.Effect<DrainSinkRecord | null, FleetDrainStepError>;
  /** Copies a previous generation's record into this one; false when it is gone. */
  readonly copy: (input: {
    readonly environmentId: EnvironmentId;
    readonly fromDrainId: string;
    readonly toDrainId: string;
    readonly threadId: string;
  }) => Effect.Effect<boolean, FleetDrainStepError>;
}

/** Exports one checkout and its checkpoint refs as base64 bundle bytes on exec
 * stdout; empty stdout means origin already holds every selected commit. */
export interface DrainGitBundle {
  readonly bundle: (input: {
    readonly environmentId: EnvironmentId;
    readonly sandboxName: string;
    readonly workspaceRoot: string;
  }) => Effect.Effect<
    { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
    FleetDrainStepError
  >;
}

/** The worker's own view of what it holds, read over its authenticated link. */
export interface DrainSource {
  readonly shell: (environmentId: EnvironmentId) => Effect.Effect<
    {
      readonly threads: ReadonlyArray<{ readonly threadId: string; readonly live: boolean }>;
      readonly projects: ReadonlyArray<{ readonly workspaceRoot: string }>;
    },
    FleetDrainStepError
  >;
  /** Cheap per-thread currency probe: the bounded read's snapshot sequence. */
  readonly threadSequence: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: string;
  }) => Effect.Effect<{ readonly snapshotSequence: number | null }, FleetDrainStepError>;
  readonly threadHistory: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: string;
  }) => Effect.Effect<
    { readonly body: string; readonly snapshotSequence: number | null },
    FleetDrainStepError
  >;
  /** The thread's attachment files; absent, the source cannot serve them. */
  readonly attachments?: (input: {
    readonly environmentId: EnvironmentId;
    readonly sandboxName: string;
    readonly threadId: string;
  }) => Effect.Effect<DrainAttachments, FleetDrainStepError>;
}

export interface DrainDependencies {
  readonly source: DrainSource;
  readonly sink: DrainSink;
  readonly git: DrainGitBundle;
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

/** The immediately preceding generation's id, or null for the first drain. */
const previousDrainId = (drainId: string): string | null => {
  const marker = drainId.lastIndexOf(":");
  if (marker < 0) return null;
  const generation = Number.parseInt(drainId.slice(marker + 1), 10);
  if (!Number.isFinite(generation) || generation <= 1) return null;
  return `${drainId.slice(0, marker)}:${generation - 1}`;
};

/**
 * Drains one worker. Every step is keyed by `drainId` and per item, so a retry
 * after a crash re-reads what already landed instead of fetching it again.
 */
export const makeDrainExecutor = (deps: DrainDependencies): DrainExecutorShape => {
  const drain = Effect.fn("FleetDrainExecutor.drain")(function* (input: DrainInput) {
    const threads = zero();
    const worktrees = zero();
    const warnings: string[] = [];
    let deadlineHit = false;
    let shellFailed = false;
    const shell = yield* deps.source.shell(input.environmentId).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          shellFailed = true;
          return { threads: [], projects: [] } as {
            threads: ReadonlyArray<{ threadId: string; live: boolean }>;
            projects: ReadonlyArray<{ workspaceRoot: string }>;
          };
        }),
      ),
    );
    if (shellFailed) {
      // Nothing could be listed, so nothing can be acked: the sandbox is kept.
      return reported({
        threads: zero(),
        worktrees: zero(),
        state: "failed",
        finishedAt: null,
      });
    }
    // A child that is still working writes after this snapshot, so copying now
    // would ack a stale thread and then delete the sandbox under it.
    const stillWorking = shell.threads.filter((thread) => thread.live);
    if (stillWorking.length > 0) {
      return reported({
        threads: { total: stillWorking.length, acked: 0, failed: stillWorking.length },
        worktrees: zero(),
        state: "failed",
        finishedAt: null,
      });
    }
    for (const thread of shell.threads) {
      if ((yield* deps.now) >= input.deadlineAt) {
        deadlineHit = true;
        break;
      }
      threads.total += 1;
      const copied = yield* Effect.gen(function* () {
        // A copy from the previous generation is trusted only while its currency
        // marker still matches the live worker; otherwise the thread is re-copied.
        const previous = previousDrainId(input.drainId);
        const prior =
          previous === null
            ? null
            : yield* deps.sink.read({
                environmentId: input.environmentId,
                drainId: previous,
                threadId: thread.threadId,
              });
        if (prior !== null && previous !== null && prior.snapshotSequence !== null) {
          const current = yield* deps.source.threadSequence({
            environmentId: input.environmentId,
            threadId: thread.threadId,
          });
          // A copy from before attachments were drained carries no manifest, so
          // it is re-copied once to pick the attachment files up.
          if (
            current.snapshotSequence === prior.snapshotSequence &&
            prior.attachments !== undefined
          ) {
            // The importer reads this generation's directory only, so the
            // verified copy is promoted instead of merely acknowledged.
            const promoted = yield* deps.sink
              .copy({
                environmentId: input.environmentId,
                fromDrainId: previous,
                toDrainId: input.drainId,
                threadId: thread.threadId,
              })
              .pipe(Effect.orElseSucceed(() => false));
            if (promoted) return true;
          }
        }
        const history = yield* deps.source.threadHistory({
          environmentId: input.environmentId,
          threadId: thread.threadId,
        });
        const attachments =
          deps.source.attachments === undefined
            ? ({ files: [], oversizeSkipped: false } as const)
            : yield* deps.source.attachments({
                environmentId: input.environmentId,
                sandboxName: input.sandboxName,
                threadId: thread.threadId,
              });
        if (attachments.oversizeSkipped) {
          warnings.push(
            `Attachments of ${thread.threadId} exceeded the drain size cap and were skipped.`,
          );
        }
        const written = yield* deps.sink.write({
          environmentId: input.environmentId,
          drainId: input.drainId,
          threadId: thread.threadId,
          body: history.body,
          snapshotSequence: history.snapshotSequence,
          ...(attachments.files.length === 0 && !attachments.oversizeSkipped
            ? {}
            : { attachments }),
        });
        // Read it back: an ack means the bytes are here, not that a write was attempted.
        const back = yield* deps.sink.read({
          environmentId: input.environmentId,
          drainId: input.drainId,
          threadId: thread.threadId,
        });
        if (
          back === null ||
          back.body !== history.body ||
          written.bytes <= 0 ||
          (back.attachmentsSkipped === true) !== attachments.oversizeSkipped
        )
          return false;
        const sent = attachments.files.map((file) => file.name).sort();
        const stored = (back.attachments ?? []).map((entry) => entry.name).sort();
        return sent.length === stored.length && sent.every((name, index) => name === stored[index]);
      }).pipe(Effect.orElseSucceed(() => false));
      if (copied) threads.acked += 1;
      else threads.failed += 1;
    }
    // A forced removal still ships the threads, which are the part that cannot be rebuilt.
    if (!input.snapshotOnly) {
      for (const project of shell.projects) {
        if ((yield* deps.now) >= input.deadlineAt) {
          deadlineHit = true;
          break;
        }
        worktrees.total += 1;
        // One bundle per checkout, keyed by its root, lands beside the thread
        // copies and is verified the same way: an ack means the bytes are here.
        // An export of nothing (origin has every commit) has no bundle to store.
        const worktreeId = `worktree:${project.workspaceRoot}`;
        const copied = yield* Effect.gen(function* () {
          const exported = yield* deps.git.bundle({
            environmentId: input.environmentId,
            sandboxName: input.sandboxName,
            workspaceRoot: project.workspaceRoot,
          });
          if (exported.exitCode !== 0)
            return yield* new FleetDrainStepError({
              step: "bundle",
              message: exported.stderr.trim() || "The checkout bundle was not created.",
            });
          // Nothing the mirror lacks: git refuses an empty bundle, and an ack
          // needs no bytes here.
          if (exported.stdout === "") return true;
          const written = yield* deps.sink.write({
            environmentId: input.environmentId,
            drainId: input.drainId,
            threadId: worktreeId,
            body: exported.stdout,
            snapshotSequence: null,
          });
          const back = yield* deps.sink.read({
            environmentId: input.environmentId,
            drainId: input.drainId,
            threadId: worktreeId,
          });
          return back !== null && back.body === exported.stdout && written.bytes > 0;
        }).pipe(Effect.orElseSucceed(() => false));
        if (copied) worktrees.acked += 1;
        else worktrees.failed += 1;
      }
    }
    // A deadline that cut the run short is never an ack, even with no failures.
    const complete = !deadlineHit && threads.failed === 0 && worktrees.failed === 0;
    return reported({
      threads,
      worktrees,
      state: complete ? "acked" : "failed",
      finishedAt: complete ? yield* deps.now : null,
      ...(warnings.length === 0 ? {} : { warnings }),
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
