import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import { projectThreadAwarenessV2, type AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
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
import {
  type DirectApnsNotification,
  alertForTransition,
  liveActivityContentForStates,
  makePhaseTracker,
  notificationForState,
} from "./directApnsPolicy.ts";

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

const START_GRACE_MS = 10_000;

const make = Effect.gen(function* () {
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const devices = yield* DirectApnsDevices.DirectApnsDevices;
  const client = yield* DirectApnsClient.DirectApnsClient;
  const tracker = makePhaseTracker();
  // The live card summarizes every thread, so it needs the current state of
  // all of them, not just the phase the tracker keeps for transitions.
  const states = new Map<ThreadId, AgentAwarenessState>();
  // Last payload sent per activity token, so unchanged state is not re-pushed
  // against APNs' update budget.
  const sentSignatures = new Map<string, string>();
  // Push-to-start tokens already used for the current burst of work. The new
  // activity's own token only reaches us when the app next runs, so without
  // this every phase change would start another card.
  const startedTokens = new Set<string>();
  // Activity tokens this server has pushed live work to. A card the app armed
  // for work this server has not seen yet is not ours to end.
  const liveTokens = new Set<string>();
  let activeSinceMs: number | null = null;
  // Alerts that ride on a device's live-activity push instead of a separate
  // banner, so one transition notifies once. Anything left unsent falls back.
  const pendingAlerts = new Map<string, DirectApnsNotification>();

  const publishLiveActivities = Effect.fn("DirectApnsNotifier.publishLiveActivities")(function* () {
    const entries = yield* devices.listLiveActivities;
    const nowMs = yield* Clock.currentTimeMillis;
    const content = liveActivityContentForStates(states.values(), nowMs);
    if (entries.length === 0) return;
    const finished = content === null || content.activeCount === 0;
    const endContent = content ?? {
      title: "T3 Code",
      subtitle: "Agent work completed",
      activeCount: 0,
      updatedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      activities: [],
    };
    if (finished) {
      startedTokens.clear();
      activeSinceMs = null;
    } else if (activeSinceMs === null) {
      activeSinceMs = nowMs;
    }
    // The app arms its own card when a thread is sent from the phone, and its
    // token arrives within seconds; a push-to-start sooner would duplicate it.
    const graceElapsed = activeSinceMs !== null && nowMs - activeSinceMs >= START_GRACE_MS;
    yield* Effect.forEach(
      entries,
      (entry) => {
        const target = {
          deviceId: entry.deviceId,
          apsEnvironment: entry.apsEnvironment,
          bundleId: entry.bundleId,
        };
        const push = (
          token: string,
          event: "start" | "update" | "end",
          payload: typeof endContent,
          alert?: DirectApnsNotification,
        ) =>
          client
            .sendLiveActivity({
              target,
              token,
              event,
              content: payload,
              ...(alert ? { alert: { title: alert.title, body: alert.body } } : {}),
            })
            .pipe(
              Effect.flatMap((result) => {
                if (result.outcome === "sent" && alert) pendingAlerts.delete(entry.deviceId);
                if (result.outcome === "sent" && event === "update") {
                  sentSignatures.set(token, JSON.stringify(payload));
                  liveTokens.add(token);
                }
                if (event === "end") liveTokens.delete(token);
                // An ended activity's token is dead; the app registers the next one.
                const dead =
                  (result.outcome === "rejected" && result.removeToken) ||
                  (result.outcome === "sent" && event === "end");
                if (!dead) return Effect.void;
                sentSignatures.delete(token);
                return devices.removeLiveActivityToken({ deviceId: entry.deviceId, token });
              }),
            );
        const activityToken = entry.activityPushToken;
        if (activityToken) {
          const alert = pendingAlerts.get(entry.deviceId);
          // Finished work stays on the card as an update, so its alert expands the
          // island; only a card with nothing left to show is ended.
          if (content === null) {
            return liveTokens.has(activityToken)
              ? push(activityToken, "end", endContent, alert)
              : Effect.void;
          }
          // A card armed for work this server has not seen is not ours to fill
          // with an older thread's finished state.
          if (finished && !liveTokens.has(activityToken)) return Effect.void;
          if (!alert && sentSignatures.get(activityToken) === JSON.stringify(content)) {
            return Effect.void;
          }
          return push(activityToken, "update", content, alert);
        }
        const startToken = entry.pushToStartToken;
        if (startToken && !finished && graceElapsed && !startedTokens.has(startToken)) {
          startedTokens.add(startToken);
          return push(startToken, "start", content);
        }
        return Effect.void;
      },
      { concurrency: SEND_CONCURRENCY, discard: true },
    );
    yield* flushPendingAlerts();
  });

  const flushPendingAlerts = Effect.fn("DirectApnsNotifier.flushPendingAlerts")(function* () {
    if (pendingAlerts.size === 0) return;
    const pending = [...pendingAlerts];
    pendingAlerts.clear();
    const all = yield* devices.list;
    yield* Effect.forEach(
      pending,
      ([deviceId, notification]) => {
        const device = all.find((candidate) => candidate.deviceId === deviceId);
        return device ? client.send({ device, notification }) : Effect.void;
      },
      { concurrency: SEND_CONCURRENCY, discard: true },
    );
  });

  const process = Effect.fn("DirectApnsNotifier.process")(function* (threadId: ThreadId) {
    if (!(yield* client.isConfigured)) {
      yield* Effect.logDebug("direct APNs notifier idle; credentials not configured");
      return;
    }
    yield* observeAndAlert(threadId);
    yield* publishLiveActivities();
  });

  const observeAndAlert = Effect.fn("DirectApnsNotifier.observeAndAlert")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* threads.getThreadShell(threadId);
    if (shell === null || shell.archivedAt !== null) {
      tracker.forget(threadId);
      states.delete(threadId);
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
    if (state === null) {
      states.delete(threadId);
      return;
    }
    states.set(threadId, state);
    const nowMs = yield* Clock.currentTimeMillis;
    const recipients = (yield* devices.list).filter((device) =>
      alertForTransition({ previous, state, preferences: device, nowMs }),
    );
    if (recipients.length === 0) return;
    const notification = notificationForState(state);
    const withLiveCard = new Set(
      (yield* devices.listLiveActivities)
        .filter((entry) => entry.activityPushToken !== undefined)
        .map((entry) => entry.deviceId),
    );
    for (const device of recipients) {
      if (withLiveCard.has(device.deviceId)) pendingAlerts.set(device.deviceId, notification);
    }
    yield* Effect.forEach(
      recipients.filter((device) => !withLiveCard.has(device.deviceId)),
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
      const state = projectThreadAwarenessV2({ environmentId, project, thread: shell });
      tracker.seed(shell.id, state);
      if (state !== null) states.set(shell.id, state);
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
