import { ExtensionOperationError, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { WORKSPACE_CHANGES_API } from "@t3tools/extension-sdk/catalogue";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import {
  WorkspaceMutationFold,
  type WorkspaceMutationActivityLike,
} from "@t3tools/shared/workspaceMutations";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { makeExtensionScopeResolver } from "./scope.ts";

const inputSchema = Schema.Struct({
  threadId: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(128)),
});
const failure = (detail: string) =>
  new ExtensionOperationError({ operation: "workspace.changes", detail });
/** Queued frames beyond this bound flip the stream to a recoverable `closed:overflow`. */
const maxQueuedEvents = 64;
/**
 * Only the activity kinds the fold can ever qualify are read or folded; all
 * other payloads stay out of server memory at the SQLite filter.
 */
const mutationActivityKinds = ["tool.completed", "tool.updated"];

interface Subscriber {
  readonly enqueue: (event: ApiStreamEvent) => void;
}

interface Watch {
  /** Monotonically increasing per-thread counter — survives watch teardown so a resubscribe observes unwatched mutations. */
  seq: number;
  /** The folded latest mutation activity id; `WorkspaceMutationFold` owns the live rows. */
  latestId: string | null;
  fold: WorkspaceMutationFold | null;
  live: { readonly scope: Scope.Scope; readonly fiber: Fiber.Fiber<void, never> } | null;
  starting: Promise<void> | null;
  /** Set when the last subscriber detaches while a start is still in flight. */
  stopping: boolean;
  readonly subscribers: Set<Subscriber>;
}

function toFoldActivity(row: {
  readonly activityId: string;
  readonly turnId: string | null;
  readonly kind: string;
  readonly payload: unknown;
  readonly sequence?: number | undefined;
  readonly createdAt: string;
}): WorkspaceMutationActivityLike {
  return {
    id: row.activityId,
    kind: row.kind,
    payload: row.payload,
    turnId: row.turnId,
    sequence: row.sequence,
    createdAt: row.createdAt,
  };
}

export function createWorkspaceChangesApiProvider(
  dependencies: Parameters<typeof makeExtensionScopeResolver>[0] & {
    readonly activities: Pick<ProjectionThreadActivityRepository["Service"], "listByThreadId">;
    readonly turns: Pick<ProjectionTurnRepository["Service"], "listByThreadId">;
    readonly events: Pick<OrchestrationEngineShape, "subscribeDomainEvents">;
  },
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  const watches = new Map<string, Watch>();

  const broadcast = (watch: Watch, event: ApiStreamEvent) => {
    for (const subscriber of watch.subscribers) subscriber.enqueue(event);
  };

  const emitMutation = (watch: Watch, at: string) => {
    watch.seq += 1;
    watch.latestId = watch.fold?.latestId ?? null;
    // A revert whose cutoff clears every qualifying row still mutated the
    // workspace — the checkpoint restore rewrote files on disk.
    const kind = watch.fold?.latestItemType ?? "file_change";
    broadcast(watch, {
      type: "data",
      value: { kind: "mutation", mutationSeq: watch.seq, kinds: [kind], at },
    });
  };

  const handleEvent = (watch: Watch, threadId: string, event: OrchestrationEvent) => {
    const fold = watch.fold;
    if (!fold) return;
    switch (event.type) {
      case "thread.activity-appended":
        if (event.payload.threadId === threadId && fold.applyActivity(event.payload.activity))
          emitMutation(watch, event.occurredAt);
        return;
      case "thread.turn-diff-completed":
        if (event.payload.threadId === threadId)
          fold.applyCheckpoint(event.payload.turnId, event.payload.checkpointTurnCount);
        return;
      case "thread.reverted":
        if (event.payload.threadId === threadId && fold.applyRevert(event.payload.turnCount))
          emitMutation(watch, event.occurredAt);
        return;
      case "thread.created":
        if (event.payload.threadId === threadId && fold.reset())
          emitMutation(watch, event.occurredAt);
        return;
      default:
        return;
    }
  };

  const stopWatch = (watch: Watch) => {
    watch.stopping = true;
    const live = watch.live;
    watch.live = null;
    watch.fold = null;
    if (!live) return;
    Effect.runFork(Fiber.interrupt(live.fiber));
    Effect.runFork(Scope.close(live.scope, Exit.void));
  };

  const failWatch = (watch: Watch) => {
    if (watch.live === null) return;
    broadcast(watch, {
      type: "closed",
      value: { kind: "closed", reason: "watch-error" },
    });
    watch.subscribers.clear();
    stopWatch(watch);
  };

  const startWatch = (watch: Watch, threadId: string, signal: AbortSignal): Promise<void> => {
    watch.starting ??= (async () => {
      let scope: Scope.Scope | null = null;
      try {
        // Attach before the seed read: events published during the seed land in
        // the scoped subscription's queue and drain after the fold is built, so
        // no mutation can slip between the read and the live feed.
        scope = await Effect.runPromise(Scope.make(), { signal });
        const events = await Effect.runPromise(
          dependencies.events.subscribeDomainEvents.pipe(Effect.provideService(Scope.Scope, scope)),
          { signal },
        );
        const [activities, turns] = await Effect.runPromise(
          Effect.all(
            [
              dependencies.activities.listByThreadId({
                threadId: ThreadId.make(threadId),
                activityKinds: mutationActivityKinds,
              }),
              dependencies.turns.listByThreadId({ threadId: ThreadId.make(threadId) }),
            ],
            { concurrency: 2 },
          ).pipe(Effect.mapError(() => failure("Workspace changes cannot read thread activity."))),
          { signal },
        );
        const fold = new WorkspaceMutationFold();
        fold.seed(
          activities.map(toFoldActivity),
          turns.map((turn) => ({
            turnId: turn.turnId,
            checkpointTurnCount: turn.checkpointTurnCount,
          })),
        );
        // Mutations folded while no subscriber was attached still advance the
        // seq — the fresh snapshot reports the new latest.
        if (fold.latestId !== watch.latestId) {
          watch.seq += 1;
          watch.latestId = fold.latestId;
        }
        watch.fold = fold;
        const fiber = Effect.runFork(
          events.pipe(
            Stream.runForEach((event) => Effect.sync(() => handleEvent(watch, threadId, event))),
            // An interruption during teardown is not a watch failure.
            Effect.catchCause(() => Effect.sync(() => failWatch(watch))),
          ),
        );
        watch.live = { scope, fiber };
        watch.starting = null;
        // The last subscriber may have detached while the seed was in flight.
        if (watch.stopping) stopWatch(watch);
      } catch (error) {
        watch.starting = null;
        if (scope !== null) Effect.runFork(Scope.close(scope, Exit.void));
        throw error;
      }
    })();
    return watch.starting;
  };

  const ensureWatch = async (threadId: string, signal: AbortSignal): Promise<Watch> => {
    let watch = watches.get(threadId);
    if (!watch) {
      watch = {
        seq: 0,
        latestId: null,
        fold: null,
        live: null,
        starting: null,
        stopping: false,
        subscribers: new Set(),
      };
      watches.set(threadId, watch);
    }
    while (watch.live === null) {
      watch.stopping = false;
      watch.starting ??= startWatch(watch, threadId, signal);
      await watch.starting;
      // A stop requested mid-start tears the fresh watch down; loop to restart.
      if (watch.live === null && !watch.stopping) throw failure("Workspace changes watch stopped.");
    }
    return watch;
  };

  return {
    providerId: "t3.host-workspace-changes",
    definition: WORKSPACE_CHANGES_API,
    invoke: () => Promise.reject(failure("Workspace changes has no methods.")),
    subscribe: (name, input, context, signal, metadata, resumeCursor) => {
      if (name !== "subscribeChanges") throw failure("Workspace changes stream is unavailable.");
      if (resumeCursor !== undefined) throw failure("Workspace changes resume is unsupported.");
      const safe = (() => {
        try {
          return Schema.decodeUnknownSync(inputSchema, { onExcessProperty: "error" })(input);
        } catch {
          throw failure("Invalid workspace changes request.");
        }
      })();
      const threadId = context.resource.threadId;
      if (!threadId) throw failure("Workspace changes requires a thread scope.");
      if (safe.threadId !== threadId)
        throw failure("Workspace changes cannot observe another thread.");

      const queue: ApiStreamEvent[] = [];
      let wake: (() => void) | null = null;
      let watch: Watch | null = null;
      let finished = false;
      let aborted = signal.aborted;
      let setup: Promise<void> | null = null;
      const controller = new AbortController();
      const runSignal = AbortSignal.any([signal, controller.signal]);
      let removeAbortListener: (() => void) | null = null;

      const subscriber: Subscriber = {
        enqueue: (event) => {
          if (finished || aborted) return;
          if (queue.length >= maxQueuedEvents) {
            const initial = queue[0];
            const preserveSnapshot = initial?.type === "snapshot";
            queue.length = 0;
            if (preserveSnapshot) queue.push(initial!);
            queue.push({
              type: "closed",
              value: { kind: "closed", reason: "overflow" },
            });
            detach();
            finish();
          } else {
            queue.push(event);
          }
          wake?.();
          wake = null;
        },
      };
      function detach() {
        if (watch === null) return;
        watch.subscribers.delete(subscriber);
        if (watch.subscribers.size === 0) stopWatch(watch);
      }
      const finish = () => {
        finished = true;
        detach();
        removeAbortListener?.();
        removeAbortListener = null;
      };
      const abort = () => {
        aborted = true;
        controller.abort();
        queue.length = 0;
        finish();
        wake?.();
        wake = null;
      };
      signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", abort);

      const iterable: AsyncIterable<ApiStreamEvent> = {
        [Symbol.asyncIterator]() {
          let returned = false;
          const failIfAborted = () => {
            if (aborted || runSignal.aborted)
              throw runSignal.reason ?? failure("Stream cancelled.");
          };
          const finishIterator = async () => {
            controller.abort();
            finish();
          };
          return {
            async next() {
              if (returned) return { done: true, value: undefined };
              failIfAborted();
              setup ??= (async () => {
                try {
                  await Effect.runPromise(resolve(context), { signal: runSignal });
                  await metadata.assertAuthority?.();
                  const attached = await ensureWatch(safe.threadId, runSignal);
                  if (aborted || runSignal.aborted) {
                    if (attached.subscribers.size === 0) stopWatch(attached);
                    return;
                  }
                  watch = attached;
                  // Attach before reading seq so the snapshot is at least as
                  // fresh as every event this subscriber can still receive.
                  attached.subscribers.add(subscriber);
                  subscriber.enqueue({
                    type: "snapshot",
                    value: { kind: "snapshot", mutationSeq: attached.seq },
                  });
                } catch (error) {
                  finish();
                  throw error;
                }
              })();
              try {
                await setup;
                failIfAborted();
                // eslint-disable-next-line no-unmodified-loop-condition
                while (queue.length === 0 && !finished) {
                  await new Promise<void>((resolveWait) => {
                    wake = resolveWait;
                  });
                  failIfAborted();
                }
                failIfAborted();
                const value = queue.shift();
                if (!value) {
                  await finishIterator();
                  returned = true;
                  return { done: true, value: undefined };
                }
                return { done: false, value };
              } catch (error) {
                await finishIterator();
                returned = true;
                throw error;
              }
            },
            async return() {
              returned = true;
              abort();
              await finishIterator();
              return { done: true, value: undefined };
            },
          };
        },
      };
      return iterable;
    },
  };
}

export const makeWorkspaceChangesApiProvider = Effect.fn("WorkspaceChangesApi.make")(function* () {
  const environment = yield* ServerEnvironment;
  return createWorkspaceChangesApiProvider({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    activities: yield* ProjectionThreadActivityRepository,
    turns: yield* ProjectionTurnRepository,
    events: yield* OrchestrationEngineService,
  });
});
