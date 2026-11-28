import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadRecap,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as ThreadRecaps from "../persistence/ThreadRecaps.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { deriveThreadRecapSource } from "./threadRecapSource.ts";

const INITIAL_IDLE_MS = 12_000;
const REFRESH_IDLE_MS = 35_000;

const EMPTY_RECAP: OrchestrationV2ThreadRecap = { status: "idle", text: null };

interface ThreadRecapEntry {
  readonly ref: SubscriptionRef.SubscriptionRef<OrchestrationV2ThreadRecap>;
  subscribers: number;
  persisted: ThreadRecaps.PersistedThreadRecap | null;
  timerFiber: Fiber.Fiber<void, never> | null;
  scheduledSignature: string | null;
  inFlightSignature: string | null;
  failedSignature: string | null;
}

export class ThreadRecapService extends Context.Service<
  ThreadRecapService,
  {
    readonly subscribe: (threadId: ThreadId) => Stream.Stream<OrchestrationV2ThreadRecap>;
  }
>()("t3/orchestration-v2/ThreadRecapService") {}

function shouldEvaluateForEvent(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "run.created":
    case "run.updated":
    case "runtime-request.updated":
    case "plan.updated":
    case "checkpoint.captured":
    case "checkpoint.rollback-requested":
    case "thread.metadata-updated":
      return true;
    case "message.updated":
      if (event.payload.role !== "user" && event.payload.role !== "assistant") {
        return false;
      }
      if (event.payload.workflowScript === true) {
        return false;
      }
      return !event.payload.streaming;
    default:
      return false;
  }
}

function toWireRecap(
  persisted: ThreadRecaps.PersistedThreadRecap | null,
  status: OrchestrationV2ThreadRecap["status"],
): OrchestrationV2ThreadRecap {
  return { status, text: persisted?.text ?? null };
}

function sameWireRecap(a: OrchestrationV2ThreadRecap, b: OrchestrationV2ThreadRecap): boolean {
  return a.status === b.status && a.text === b.text;
}

function clearSchedule(entry: ThreadRecapEntry) {
  entry.timerFiber = null;
  entry.scheduledSignature = null;
  entry.inFlightSignature = null;
}

const logFailure = (message: string, annotations?: Record<string, unknown>) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...annotations, cause }),
  );

const make = Effect.fn("ThreadRecapService.make")(function* () {
  const repository = yield* ThreadRecaps.ThreadRecapRepository;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  const serviceScope = yield* Scope.Scope;

  const entries = new Map<ThreadId, ThreadRecapEntry>();
  const threadLock = yield* KeyedLock.make<ThreadId>();

  const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    threadLock.withLock(threadId, effect);

  const publish = (entry: ThreadRecapEntry, next: OrchestrationV2ThreadRecap) =>
    SubscriptionRef.set(entry.ref, next);

  // Traced by the enclosing service operation; forkIn avoids waiting on a fiber while holding threadLock.
  const cancelTimer = Effect.fnUntraced(function* (entry: ThreadRecapEntry) {
    const fiber = entry.timerFiber;
    clearSchedule(entry);
    if (fiber !== null) {
      yield* Effect.forkIn(Fiber.interrupt(fiber), serviceScope);
    }
  });

  const loadPersisted = (threadId: ThreadId) =>
    repository.get(threadId).pipe(
      Effect.map(Option.getOrNull),
      logFailure("Failed to load persisted thread recap", { threadId }),
      Effect.map((persisted) => persisted ?? null),
    );

  const readSource = Effect.fn("ThreadRecapService.readSource")(function* (
    threadId: ThreadId,
    persisted: ThreadRecaps.PersistedThreadRecap | null,
  ) {
    const projection = yield* threads
      .getThreadRecords(threadId, ["messages", "runs", "runtimeRequests", "plans", "checkpoints"], {
        messageRoles: ["user", "assistant"],
      })
      .pipe(Effect.option);
    if (Option.isNone(projection) || projection.value.thread.deletedAt !== null) {
      return null;
    }
    return {
      thread: projection.value.thread,
      source: deriveThreadRecapSource({
        thread: projection.value.thread,
        messages: projection.value.messages,
        runs: projection.value.runs,
        runtimeRequests: projection.value.runtimeRequests,
        plans: projection.value.plans,
        checkpoints: projection.value.checkpoints,
        previousCoveredMessageId: persisted?.coveredMessageId ?? null,
        hasPreviousRecap: Boolean(persisted?.text),
      }),
    };
  });

  const runGeneration: (
    threadId: ThreadId,
    scheduledSignature: string,
    delayMs: number,
  ) => Effect.Effect<void> = Effect.fn("ThreadRecapService.runGeneration")(function* (
    threadId: ThreadId,
    scheduledSignature: string,
    delayMs: number,
  ) {
    if (delayMs > 0) {
      yield* Effect.sleep(Duration.millis(delayMs));
    }

    const prepared = yield* withThreadLock(
      threadId,
      Effect.gen(function* () {
        const entry = entries.get(threadId);
        if (!entry || entry.subscribers <= 0 || entry.scheduledSignature !== scheduledSignature) {
          return null;
        }
        const settings = yield* serverSettings.getSettings.pipe(Effect.option);
        if (Option.isNone(settings) || !settings.value.threadRecapEnabled) {
          clearSchedule(entry);
          yield* publish(entry, toWireRecap(entry.persisted, "idle"));
          return null;
        }
        const current = yield* readSource(threadId, entry.persisted);
        if (
          current === null ||
          !current.source.isSettled ||
          !current.source.hasNewMaterial ||
          current.source.signature !== scheduledSignature ||
          current.source.signature === entry.persisted?.sourceSignature
        ) {
          clearSchedule(entry);
          yield* publish(entry, toWireRecap(entry.persisted, "idle"));
          return null;
        }
        const project = yield* projects.get(current.thread.projectId).pipe(Effect.option);
        if (Option.isNone(project) || Option.isNone(project.value)) {
          clearSchedule(entry);
          entry.failedSignature = scheduledSignature;
          yield* publish(entry, toWireRecap(entry.persisted, "error"));
          return null;
        }
        const worktreePath = current.thread.worktreePath;
        const worktreeExists =
          worktreePath !== null &&
          (yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => false)));
        const resolvedSettings = resolveProjectSettings(
          settings.value,
          current.thread.projectId,
        ).settings;

        entry.inFlightSignature = scheduledSignature;
        yield* publish(entry, toWireRecap(entry.persisted, "pending"));
        return {
          cwd: worktreeExists ? worktreePath : project.value.value.workspaceRoot,
          projectId: current.thread.projectId,
          modelSelection: resolvedSettings.textGenerationModelSelection,
          previousRecap: entry.persisted?.text,
          source: current.source,
        };
      }),
    );

    if (prepared === null) {
      return;
    }

    const generated = yield* textGeneration
      .generateThreadRecap({
        cwd: prepared.cwd,
        ...(prepared.previousRecap ? { previousRecap: prepared.previousRecap } : {}),
        newMaterial: prepared.source.newMaterial,
        currentState: prepared.source.currentState,
        modelSelection: prepared.modelSelection,
        projectId: prepared.projectId,
      })
      .pipe(Effect.exit);

    if (generated._tag === "Failure" && Cause.hasInterruptsOnly(generated.cause)) {
      return;
    }

    const shouldReevaluate = yield* withThreadLock(
      threadId,
      Effect.gen(function* () {
        const entry = entries.get(threadId);
        if (!entry || entry.inFlightSignature !== scheduledSignature) {
          return false;
        }
        entry.inFlightSignature = null;
        if (entry.scheduledSignature === scheduledSignature) {
          entry.timerFiber = null;
          entry.scheduledSignature = null;
        }

        if (generated._tag === "Failure") {
          yield* Effect.logWarning("Thread recap generation failed", {
            threadId,
            cause: generated.cause,
          });
          entry.failedSignature = scheduledSignature;
          yield* publish(entry, toWireRecap(entry.persisted, "error"));
          return false;
        }

        const settings = yield* serverSettings.getSettings.pipe(Effect.option);
        if (Option.isNone(settings) || !settings.value.threadRecapEnabled) {
          yield* publish(entry, toWireRecap(entry.persisted, "idle"));
          return false;
        }

        const latest = yield* readSource(threadId, entry.persisted);
        if (latest === null) {
          yield* publish(entry, toWireRecap(entry.persisted, "idle"));
          return false;
        }
        // Discard stale generation if newer messages arrived while the model ran.
        if (latest.source.signature !== scheduledSignature) {
          yield* publish(entry, toWireRecap(entry.persisted, "idle"));
          return entry.subscribers > 0;
        }

        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const nextPersisted: ThreadRecaps.PersistedThreadRecap = {
          threadId,
          text: generated.value.recap,
          coveredMessageId: prepared.source.latestMessageId,
          sourceSignature: scheduledSignature,
          updatedAt: nowIso,
        };
        yield* repository
          .put(nextPersisted)
          .pipe(logFailure("Failed to persist thread recap", { threadId }));
        entry.persisted = nextPersisted;
        entry.failedSignature = null;
        yield* publish(entry, toWireRecap(nextPersisted, "idle"));
        return false;
      }),
    );

    if (shouldReevaluate) {
      yield* evaluate(threadId);
    }
  });

  const evaluate: (threadId: ThreadId) => Effect.Effect<void> = Effect.fn(
    "ThreadRecapService.evaluate",
  )(function* (threadId: ThreadId) {
    yield* withThreadLock(
      threadId,
      Effect.gen(function* () {
        const entry = entries.get(threadId);
        if (!entry || entry.subscribers <= 0) {
          return;
        }

        const settings = yield* serverSettings.getSettings.pipe(Effect.option);
        if (Option.isNone(settings) || !settings.value.threadRecapEnabled) {
          yield* cancelTimer(entry);
          yield* publish(entry, toWireRecap(entry.persisted, "idle"));
          return;
        }

        const current = yield* readSource(threadId, entry.persisted);
        if (current === null) {
          yield* cancelTimer(entry);
          yield* publish(entry, toWireRecap(entry.persisted, "idle"));
          return;
        }

        const { source } = current;
        if (!source.isSettled) {
          // Do not interrupt an in-flight model call; only cancel a waiting debounce timer.
          if (entry.inFlightSignature === null) {
            yield* cancelTimer(entry);
          }
          return;
        }

        if (
          !source.hasNewMaterial ||
          source.signature === entry.persisted?.sourceSignature ||
          source.signature === entry.failedSignature
        ) {
          if (entry.inFlightSignature === null) {
            yield* cancelTimer(entry);
          }
          return;
        }

        if (entry.scheduledSignature === source.signature && entry.timerFiber !== null) {
          return;
        }

        yield* cancelTimer(entry);
        entry.scheduledSignature = source.signature;
        const delayMs = entry.persisted?.text ? REFRESH_IDLE_MS : INITIAL_IDLE_MS;
        entry.timerFiber = yield* Effect.forkIn(
          runGeneration(threadId, source.signature, delayMs),
          serviceScope,
        );
      }),
    );
  });

  // The stored row goes with the thread's content purge; this only clears live viewers.
  const handleThreadDeleted = Effect.fn("ThreadRecapService.handleThreadDeleted")(function* (
    threadId: ThreadId,
  ) {
    yield* withThreadLock(
      threadId,
      Effect.gen(function* () {
        const entry = entries.get(threadId);
        if (entry) {
          yield* cancelTimer(entry);
          entry.persisted = null;
          entry.failedSignature = null;
          yield* publish(entry, EMPTY_RECAP);
        }
      }),
    );
  });

  yield* forkParked(
    orchestrator.streamDomainEvents.pipe(
      Stream.runForEach((event) => {
        if (event.type === "thread.deleted") {
          return handleThreadDeleted(event.threadId);
        }
        const entry = entries.get(event.threadId);
        if (!entry || entry.subscribers <= 0 || !shouldEvaluateForEvent(event)) {
          return Effect.void;
        }
        return evaluate(event.threadId);
      }),
      logFailure("Thread recap event watcher failed"),
    ),
  );

  const settingsChanges = yield* serverSettings.subscribeChanges;
  yield* forkParked(
    settingsChanges.pipe(
      Stream.map((settings) => settings.threadRecapEnabled),
      Stream.changes,
      Stream.runForEach(() =>
        Effect.forEach([...entries.keys()], (threadId) => evaluate(threadId), {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
      logFailure("Thread recap settings watcher failed"),
    ),
  );

  const subscribe: ThreadRecapService["Service"]["subscribe"] = (threadId) =>
    Stream.unwrap(
      Effect.acquireRelease(
        withThreadLock(
          threadId,
          Effect.gen(function* () {
            let entry = entries.get(threadId);
            if (!entry) {
              const persisted = yield* loadPersisted(threadId);
              const ref = yield* SubscriptionRef.make<OrchestrationV2ThreadRecap>(
                toWireRecap(persisted, "idle"),
              );
              entry = {
                ref,
                subscribers: 0,
                persisted,
                timerFiber: null,
                scheduledSignature: null,
                inFlightSignature: null,
                failedSignature: null,
              };
              entries.set(threadId, entry);
            }
            entry.subscribers += 1;
            return entry;
          }),
        ).pipe(Effect.tap(() => evaluate(threadId))),
        (entry) =>
          withThreadLock(
            threadId,
            Effect.gen(function* () {
              entry.subscribers = Math.max(0, entry.subscribers - 1);
              if (entry.subscribers === 0) {
                yield* cancelTimer(entry);
                if (entries.get(threadId) === entry) {
                  entries.delete(threadId);
                }
              }
            }),
          ),
      ).pipe(
        Effect.map((entry) =>
          SubscriptionRef.changes(entry.ref).pipe(Stream.changesWith(sameWireRecap)),
        ),
      ),
    );

  return ThreadRecapService.of({ subscribe });
});

export const layer = Layer.effect(ThreadRecapService, make());
