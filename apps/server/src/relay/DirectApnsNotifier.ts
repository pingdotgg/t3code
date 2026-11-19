import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as DirectApnsClient from "./DirectApnsClient.ts";
import * as DirectApnsDevices from "./DirectApnsDevices.ts";
import { alertForTransition, makePhaseTracker, notificationForState } from "./directApnsPolicy.ts";

const SEND_CONCURRENCY = 4;

// Only these events can change a thread's awareness phase. Turn-item updates matter
// when they end background work that was holding a completion back.
const PHASE_EVENT_TYPES = new Set<string>([
  "thread.created",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.settled",
  "run.created",
  "run.updated",
  "runtime-request.updated",
  "subagent.updated",
  "provider-thread.updated",
]);

function affectsAwarenessPhase(event: OrchestrationV2DomainEvent): boolean {
  if (PHASE_EVENT_TYPES.has(event.type)) return true;
  const payload: unknown = "payload" in event ? event.payload : undefined;
  return (
    event.type === "turn-item.updated" &&
    typeof payload === "object" &&
    payload !== null &&
    "type" in payload &&
    "status" in payload &&
    turnItemUpdateCanEndBackgroundWork(
      payload as Parameters<typeof turnItemUpdateCanEndBackgroundWork>[0],
    )
  );
}

/**
 * Sends alert pushes straight to APNs for threads on this environment, for
 * forks whose bundle ID the official relay's APNs key cannot reach. It reads the
 * same domain events and awareness projection as AgentAwarenessRelay but is
 * independent of T3 Connect: no relay link is required.
 */
export class DirectApnsNotifier extends Context.Service<
  DirectApnsNotifier,
  {
    readonly observeThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/relay/DirectApnsNotifier") {}

const make = Effect.gen(function* () {
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const devices = yield* DirectApnsDevices.DirectApnsDevices;
  const client = yield* DirectApnsClient.DirectApnsClient;
  const tracker = makePhaseTracker();

  const process = Effect.fn("DirectApnsNotifier.process")(function* (threadId: ThreadId) {
    if (!(yield* client.isConfigured)) {
      yield* Effect.logDebug("direct APNs notifier idle; credentials not configured");
      return;
    }
    const shell = yield* threads.getThreadShell(threadId);
    if (shell === null || shell.archivedAt !== null) {
      tracker.forget(threadId);
      return;
    }
    const project = yield* projects.getById(shell.projectId);
    if (Option.isNone(project)) return;
    const state = projectThreadAwarenessV2({
      environmentId: yield* serverEnvironment.getEnvironmentId,
      project: project.value,
      thread: shell,
    });
    const { previous } = tracker.observe(threadId, state);
    if (state === null) return;
    const nowMs = yield* Clock.currentTimeMillis;
    const recipients = (yield* devices.list).filter((device) =>
      alertForTransition({ previous, state, preferences: device, nowMs }),
    );
    if (recipients.length === 0) return;
    const notification = notificationForState(state);
    yield* Effect.forEach(
      recipients,
      (device) =>
        client.send({ device, notification }).pipe(
          Effect.flatMap((result) =>
            result.outcome === "rejected" && result.removeToken
              ? devices.removeRejectedToken({
                  deviceId: device.deviceId,
                  apnsToken: device.apnsToken,
                })
              : Effect.void,
          ),
        ),
      { concurrency: SEND_CONCURRENCY, discard: true },
    );
  });

  // A thread queued twice before its turn is processed is read once, from the latest state.
  const queued = new Set<ThreadId>();
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.sync(() => queued.delete(threadId)).pipe(
      Effect.andThen(process(threadId)),
      // A failing push must never disturb the thread or the relay publish path.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("direct APNs notification failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );
  const enqueue = (threadId: ThreadId) =>
    Effect.suspend(() => {
      if (queued.has(threadId)) return Effect.void;
      queued.add(threadId);
      return worker.enqueue(threadId);
    });

  // Threads already waiting or finished at startup are the baseline, not news.
  const seedBaseline = Effect.gen(function* () {
    const [projectSnapshot, shellSnapshot] = yield* Effect.all([
      projects.snapshot,
      threads.getShellSnapshot(),
    ]);
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const projectById = new Map(projectSnapshot.projects.map((project) => [project.id, project]));
    for (const shell of shellSnapshot.threads) {
      const project = projectById.get(shell.projectId);
      if (!project || shell.archivedAt !== null) continue;
      tracker.seed(shell.id, projectThreadAwarenessV2({ environmentId, project, thread: shell }));
    }
  });

  return DirectApnsNotifier.of({
    observeThread: enqueue,
    drain: worker.drain,
    start: Effect.fn("DirectApnsNotifier.start")(function* () {
      yield* forkParked(
        seedBaseline.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("direct APNs baseline failed", { cause: Cause.pretty(cause) }),
          ),
        ),
      );
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, (event) =>
          affectsAwarenessPhase(event) ? enqueue(event.threadId) : Effect.void,
        ),
      );
    }),
  });
});

export const layer = Layer.effect(DirectApnsNotifier, make);
