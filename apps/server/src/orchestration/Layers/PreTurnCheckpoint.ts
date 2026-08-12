import { CommandId, MessageId, type ProjectId, type TurnId } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { PreTurnCheckpoint, type PreTurnCheckpointShape } from "../Services/PreTurnCheckpoint.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";

/** @internal Exposed for deterministic concurrency and lifetime coverage. */
export const makeKeyedWorkspaceBoundary = Effect.gen(function* () {
  const locks = yield* Ref.make(
    new Map<string, { readonly semaphore: Semaphore.Semaphore; readonly users: number }>(),
  );
  const withBoundary = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const semaphore = yield* Ref.modify(locks, (current) => {
          const existing = current.get(key);
          const entry = existing
            ? { semaphore: existing.semaphore, users: existing.users + 1 }
            : { semaphore: Semaphore.makeUnsafe(1), users: 1 };
          const next = new Map(current);
          next.set(key, entry);
          return [entry.semaphore, next] as const;
        });
        const releaseRegistration = Ref.update(locks, (current) => {
          const existing = current.get(key);
          if (!existing) {
            return current;
          }
          const next = new Map(current);
          if (existing.users === 1) {
            next.delete(key);
          } else {
            next.set(key, { semaphore: existing.semaphore, users: existing.users - 1 });
          }
          return next;
        });
        return yield* restore(semaphore.withPermit(effect)).pipe(
          Effect.ensuring(releaseRegistration),
        );
      }),
    );

  return {
    withBoundary,
    activeKeyCount: Ref.get(locks).pipe(Effect.map((current) => current.size)),
  } as const;
});

const make = Effect.gen(function* () {
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceBoundaries = yield* makeKeyedWorkspaceBoundary;

  const withWorkspaceBoundary: PreTurnCheckpointShape["withWorkspaceBoundary"] = (cwd, effect) =>
    workspaceBoundaries.withBoundary(normalizeProjectPathForComparison(cwd), effect);

  const resolveProject = Effect.fn("PreTurnCheckpoint.resolveProject")(function* (
    projectId: ProjectId,
  ) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const ensure: PreTurnCheckpointShape["ensure"] = Effect.fn("PreTurnCheckpoint.ensure")(
    function* (input) {
      const thread = yield* projectionSnapshotQuery
        .getThreadDetailById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (!thread) {
        return;
      }

      const project = yield* resolveProject(thread.projectId);
      const cwd = resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      });
      if (!cwd || !isGitRepository(cwd)) {
        return;
      }

      yield* withWorkspaceBoundary(
        cwd,
        Effect.gen(function* () {
          // Completion finalization may have advanced the checkpoint while
          // this ensure waited for the workspace boundary. Re-read under the
          // lock so we establish the baseline for the actual next turn.
          const currentThread = yield* projectionSnapshotQuery
            .getThreadDetailById(input.threadId)
            .pipe(Effect.map(Option.getOrUndefined));
          if (!currentThread) {
            return;
          }

          const adoptCheckpointRef = Effect.fn("PreTurnCheckpoint.adoptCheckpointRef")(
            function* (checkpoint: {
              readonly turnId: TurnId;
              readonly checkpointTurnCount: number;
              readonly checkpointRef: ReturnType<typeof checkpointRefForThreadTurn>;
            }) {
              const assistantMessageId =
                currentThread.messages
                  .toReversed()
                  .find(
                    (message) =>
                      message.role === "assistant" && message.turnId === checkpoint.turnId,
                  )?.id ?? MessageId.make(`assistant:${checkpoint.turnId}`);

              yield* orchestrationEngine.dispatch({
                type: "thread.turn.diff.complete",
                commandId: CommandId.make(
                  `checkpoint:orphan-adopt:${currentThread.id}:${checkpoint.turnId}:${checkpoint.checkpointTurnCount}`,
                ),
                threadId: currentThread.id,
                turnId: checkpoint.turnId,
                completedAt: input.createdAt,
                checkpointRef: checkpoint.checkpointRef,
                status: "ready",
                files: [],
                assistantMessageId,
                checkpointTurnCount: checkpoint.checkpointTurnCount,
                createdAt: input.createdAt,
              });
              yield* receiptBus.publish({
                type: "checkpoint.diff.finalized",
                threadId: currentThread.id,
                turnId: checkpoint.turnId,
                checkpointTurnCount: checkpoint.checkpointTurnCount,
                checkpointRef: checkpoint.checkpointRef,
                status: "ready",
                createdAt: input.createdAt,
              });
              yield* receiptBus.publish({
                type: "turn.processing.quiesced",
                threadId: currentThread.id,
                turnId: checkpoint.turnId,
                checkpointTurnCount: checkpoint.checkpointTurnCount,
                createdAt: input.createdAt,
              });
            },
          );

          // A live provider diff may already have projected a missing
          // placeholder at count N before terminal capture materializes ref N.
          // If the process exits between that ref write and diff.complete,
          // max(checkpoint count) is already N; checking only N+1 would miss
          // the orphan forever. Reconcile the exact placeholder/ref pair
          // before considering the next-count orphan or a new baseline.
          for (const placeholder of currentThread.checkpoints
            .filter((checkpoint) => checkpoint.status === "missing")
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)) {
            const placeholderRef = checkpointRefForThreadTurn(
              currentThread.id,
              placeholder.checkpointTurnCount,
            );
            if (
              yield* checkpointStore.hasCheckpointRef({
                cwd,
                checkpointRef: placeholderRef,
              })
            ) {
              yield* adoptCheckpointRef({
                turnId: placeholder.turnId,
                checkpointTurnCount: placeholder.checkpointTurnCount,
                checkpointRef: placeholderRef,
              });
              return;
            }
          }

          const checkpointTurnCount = currentThread.checkpoints.reduce(
            (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
            0,
          );

          // A checkpoint ref is written before its projection event. If the
          // process exits in that gap, adopt the already-materialized next ref
          // before a provider can mutate the workspace again. Otherwise the
          // next completion would reuse and overwrite that boundary.
          const orphanCheckpointTurnCount = checkpointTurnCount + 1;
          const orphanCheckpointRef = checkpointRefForThreadTurn(
            currentThread.id,
            orphanCheckpointTurnCount,
          );
          const orphanCheckpointExists = yield* checkpointStore.hasCheckpointRef({
            cwd,
            checkpointRef: orphanCheckpointRef,
          });
          if (orphanCheckpointExists) {
            const orphanTurnId =
              currentThread.session?.activeTurnId ?? currentThread.latestTurn?.turnId;
            if (!orphanTurnId) {
              // Do not guess correlation and let the next provider overwrite
              // an unexplained boundary. A real completion orphan always has
              // an active/latest authoritative turn; missing both indicates
              // state that requires an explicit retry/recovery decision.
              return yield* new OrchestrationCommandInvariantError({
                commandType: "thread.turn.diff.complete",
                detail: `Checkpoint ref '${orphanCheckpointRef}' has no authoritative turn to adopt.`,
              });
            }
            yield* adoptCheckpointRef({
              turnId: orphanTurnId,
              checkpointTurnCount: orphanCheckpointTurnCount,
              checkpointRef: orphanCheckpointRef,
            });
            return;
          }

          const checkpointRef = checkpointRefForThreadTurn(currentThread.id, checkpointTurnCount);
          const exists = yield* checkpointStore.hasCheckpointRef({ cwd, checkpointRef });
          if (exists) {
            return;
          }

          yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef });
          yield* receiptBus.publish({
            type: "checkpoint.baseline.captured",
            threadId: currentThread.id,
            checkpointTurnCount,
            checkpointRef,
            createdAt: input.createdAt,
          });
        }),
      );
    },
  );

  return PreTurnCheckpoint.of({ ensure, withWorkspaceBoundary });
});

export const PreTurnCheckpointLive = Layer.effect(PreTurnCheckpoint, make);
