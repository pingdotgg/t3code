import { ActivitySummaries } from "../pseudocode/ActivitySummaries.ts";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  type DirectPushDelivery,
  DirectPushRegistration,
  type DirectPushStatus,
  type ThreadId,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2, type AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Schema,
  Schedule,
  Semaphore,
  Stream,
  type Scope,
} from "effect";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { AuthSessionRepository } from "../persistence/AuthSessions.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { eventThreadId, shouldPublishAgentAwarenessEvent } from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import { ApnsTransport, ApnsTransportError, type ApnsRequest } from "./ApnsTransport.ts";
import {
  activityIdentity,
  aggregateActivity,
  attentionPayload,
  compactWidgetUpdate,
  isActive,
  liveActivityPayload,
} from "./payloads.ts";

/** Background pushes are budgeted by iOS; below the widget's 25 minute delayed threshold. */
const HEARTBEAT_INTERVAL = "10 minutes";

const RecordSchema = Schema.Struct({
  sessionId: AuthSessionId,
  registration: DirectPushRegistration,
});
type DeviceRecord = typeof RecordSchema.Type;
const RecordsJson = Schema.fromJsonString(Schema.Array(RecordSchema));
const decodeRecords = Schema.decodeUnknownEffect(RecordsJson);
const encodeRecords = Schema.encodeEffect(RecordsJson);
const STORAGE_KEY = "direct-apns-devices";
export class DirectPushError extends Schema.TaggedError<DirectPushError>()("DirectPushError", {
  message: Schema.String,
}) {}
const operationError = () =>
  new DirectPushError({ message: "Direct push registration or snapshot failed." });

export class DirectPush extends Context.Service<
  DirectPush,
  {
    readonly status: (sessionId: AuthSessionId) => Effect.Effect<DirectPushStatus, DirectPushError>;
    readonly register: (
      sessionId: AuthSessionId,
      registration: DirectPushRegistration,
    ) => Effect.Effect<DirectPushStatus, DirectPushError>;
    readonly unregister: (sessionId: AuthSessionId) => Effect.Effect<void, DirectPushError>;
    readonly publishThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly refresh: () => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/push/DirectPush") {}

export const make = Effect.gen(function* () {
  const summaries = yield* Effect.serviceOption(ActivitySummaries);
  const transport = yield* ApnsTransport;
  const secrets = yield* ServerSecretStore;
  const sessions = yield* AuthSessionRepository;
  const query = yield* ThreadManagementService;
  const projectService = yield* ProjectService;
  const environment = yield* ServerEnvironment;
  const mutex = yield* Semaphore.make(1);
  const states = new Map<ThreadId, AgentAwarenessState>();
  const seenRequests = new Map<ThreadId, Set<string>>();
  const lastWidgetPush = new Map<AuthSessionId, number>();
  // In memory: a restart clears it, and the next push records a fresh result.
  const lastDelivery = new Map<AuthSessionId, DirectPushDelivery>();
  const rememberDelivery = (
    sessionId: AuthSessionId,
    kind: DirectPushDelivery["kind"],
    status: number | null,
    reason: string | null,
  ) =>
    DateTime.now.pipe(
      Effect.map((at) => {
        lastDelivery.set(sessionId, { at: DateTime.formatIso(at), kind, status, reason });
      }),
    );
  let hydrated = false;
  const stored = yield* secrets.get(STORAGE_KEY);
  let records: readonly DeviceRecord[] = Option.isSome(stored)
    ? yield* decodeRecords(new TextDecoder().decode(stored.value))
    : [];

  const persist = Effect.fn("DirectPush.persist")(function* (next: readonly DeviceRecord[]) {
    const json = yield* encodeRecords(next);
    yield* secrets.set(STORAGE_KEY, new TextEncoder().encode(json));
    records = next;
  });
  const hydrate = Effect.gen(function* () {
    if (hydrated) return;
    const snapshot = yield* query.getShellSnapshot();
    const environmentId = yield* environment.getEnvironmentId;
    const projects = new Map(
      (yield* projectService.snapshot).projects.map((project) => [project.id, project]),
    );
    for (const thread of snapshot.threads) {
      const project = projects.get(thread.projectId);
      if (!project || thread.archivedAt !== null) continue;
      const state = projectThreadAwarenessV2({ environmentId, project, thread });
      if (state) states.set(thread.id, state);
      seenRequests.set(
        thread.id,
        new Set(thread.pendingRuntimeRequest ? [thread.pendingRuntimeRequest.id] : []),
      );
    }
    hydrated = true;
  });
  const aggregate = Effect.gen(function* () {
    yield* hydrate;
    return aggregateActivity(states.values(), DateTime.formatIso(yield* DateTime.now));
  });
  const send = (request: ApnsRequest) =>
    transport.send(request).pipe(
      Effect.filterOrFail(
        (response) => response.status !== 429 && response.status < 500,
        (response) =>
          new ApnsTransportError({
            message: `APNs temporarily unavailable (${response.status}).`,
          }),
      ),
      Effect.retry({ schedule: Schedule.exponential("1 second"), times: 2 }),
    );
  const deliver = Effect.fn("DirectPush.deliver")(function* (
    record: DeviceRecord,
    attention: AgentAwarenessState | null,
    forceEnd = false,
    statusChanged = false,
  ) {
    const registration = record.registration;
    if (registration.bundleId !== transport.bundleId) return;
    const session = yield* sessions.getById({ sessionId: record.sessionId });
    const now = yield* DateTime.now;
    if (
      Option.isNone(session) ||
      session.value.revokedAt !== null ||
      session.value.expiresAt.epochMilliseconds <= now.epochMilliseconds ||
      !session.value.scopes.includes(AuthOrchestrationReadScope)
    ) {
      yield* persist(records.filter((item) => item !== record));
      lastDelivery.delete(record.sessionId);
      return;
    }
    const push = Effect.fn("DirectPush.send")(function* (
      kind: "alert" | "liveactivity" | "background",
      token: string,
      payload: unknown,
    ) {
      const response = yield* send({
        token,
        kind,
        environment: registration.apsEnvironment,
        payload,
        ...(kind === "background" ? { collapseId: "agent-widget" } : {}),
      }).pipe(
        Effect.tapError((error) => rememberDelivery(record.sessionId, kind, null, error.message)),
      );
      yield* rememberDelivery(record.sessionId, kind, response.status, response.reason ?? null);
      if (
        response.status === 410 ||
        response.reason === "BadDeviceToken" ||
        response.reason === "DeviceTokenNotForTopic"
      ) {
        const field = kind === "liveactivity" ? "activityToken" : "pushToken";
        yield* persist(
          records.map((item) =>
            item.sessionId === record.sessionId
              ? { ...item, registration: { ...item.registration, [field]: null } }
              : item,
          ),
        );
      }
      if (response.status !== 200)
        yield* Effect.logWarning("Direct APNs delivery rejected", {
          kind,
          status: response.status,
          reason: response.reason,
        });
    });
    const current = [...states.values()];
    const widgetUpdate = compactWidgetUpdate({
      environmentId: yield* environment.getEnvironmentId,
      activity: yield* aggregate,
      attentionCount: current.filter((state) => state.phase.startsWith("waiting")).length,
      approvalCount: current.filter((state) => state.phase === "waiting_for_approval").length,
      activeProjectCount: new Set(current.filter(isActive).map((state) => state.projectId)).size,
    });
    if (attention && registration.notificationsEnabled && registration.pushToken) {
      const payload = attentionPayload(attention);
      yield* push("alert", registration.pushToken, {
        ...payload,
        aps: { ...payload.aps, "content-available": 1 },
        directWidget: widgetUpdate,
      });
      lastWidgetPush.set(record.sessionId, now.epochMilliseconds);
    } else if (
      !forceEnd &&
      registration.pushToken &&
      (statusChanged ||
        !lastWidgetPush.has(record.sessionId) ||
        now.epochMilliseconds - lastWidgetPush.get(record.sessionId)! >= 5 * 60_000)
    ) {
      yield* push("background", registration.pushToken, {
        aps: { "content-available": 1 },
        directWidget: widgetUpdate,
      });
      lastWidgetPush.set(record.sessionId, now.epochMilliseconds);
    }
    if (registration.activityToken && (registration.liveActivitiesEnabled || forceEnd)) {
      const state = yield* aggregate;
      const end = forceEnd || state.activeCount === 0;
      const environmentId = yield* environment.getEnvironmentId;
      yield* push(
        "liveactivity",
        registration.activityToken,
        liveActivityPayload(
          state,
          Math.floor(now.epochMilliseconds / 1000),
          end,
          `DirectAgentActivity:${environmentId}`,
          registration.appScheme,
        ),
      );
      if (end)
        yield* persist(
          records.map((item) =>
            item.sessionId === record.sessionId
              ? { ...item, registration: { ...item.registration, activityToken: null } }
              : item,
          ),
        );
    }
  });
  const statusUnsafe = Effect.fn("DirectPush.status")(function* (sessionId: AuthSessionId) {
    const delivery = lastDelivery.get(sessionId);
    return {
      configured: transport.bundleId !== null,
      bundleId: transport.bundleId,
      registered: records.some(
        (record) =>
          record.sessionId === sessionId && record.registration.bundleId === transport.bundleId,
      ),
      activity: yield* aggregate,
      ...(delivery ? { lastDelivery: delivery } : {}),
    };
  });
  const status = (sessionId: AuthSessionId) => mutex.withPermit(statusUnsafe(sessionId));
  const register = (sessionId: AuthSessionId, registration: DirectPushRegistration) =>
    mutex.withPermit(
      Effect.gen(function* () {
        if (transport.bundleId !== registration.bundleId) return yield* statusUnsafe(sessionId);
        yield* hydrate;
        const previous = records.find((record) => record.sessionId === sessionId);
        if (
          previous?.registration.activityToken &&
          (!registration.liveActivitiesEnabled ||
            (registration.activityToken !== null &&
              previous.registration.activityToken !== registration.activityToken))
        ) {
          yield* deliver(previous, null, true);
        }
        const record = { sessionId, registration };
        // A reinstall or re-pairing supersedes this device's previous registration.
        yield* persist([
          ...records.filter(
            (item) =>
              item.sessionId !== sessionId && item.registration.deviceId !== registration.deviceId,
          ),
          record,
        ]);
        yield* deliver(record, null);
        return yield* statusUnsafe(sessionId);
      }),
    );
  const unregister = (sessionId: AuthSessionId) =>
    mutex.withPermit(
      Effect.gen(function* () {
        const record = records.find((item) => item.sessionId === sessionId);
        if (record) yield* deliver(record, null, true).pipe(Effect.ignore);
        yield* persist(records.filter((item) => item.sessionId !== sessionId));
        lastDelivery.delete(sessionId);
      }),
    );
  const publishThread = (threadId: ThreadId) =>
    mutex
      .withPermit(
        Effect.gen(function* () {
          if (!transport.bundleId) return;
          yield* hydrate;
          const thread = Option.fromNullishOr(yield* query.getThreadShell(threadId));
          const project = Option.isSome(thread)
            ? yield* projectService.getById(thread.value.projectId)
            : Option.none();
          let next =
            Option.isSome(thread) && Option.isSome(project) && thread.value.archivedAt === null
              ? projectThreadAwarenessV2({
                  environmentId: yield* environment.getEnvironmentId,
                  project: project.value,
                  thread: thread.value,
                })
              : null;
          if (
            next &&
            Option.isSome(summaries) &&
            Option.isSome(thread) &&
            Option.isSome(project) &&
            records.length > 0
          ) {
            next = yield* summaries.value.enrich({
              state: next,
              thread: thread.value,
              project: project.value,
            });
          }
          const previous = states.get(threadId);
          const seen = seenRequests.get(threadId) ?? new Set<string>();
          const request = Option.isSome(thread) ? thread.value.pendingRuntimeRequest : null;
          const phase =
            next !== null && request !== null && !seen.has(request.id)
              ? request.kind === "user_input"
                ? "waiting_for_input"
                : "waiting_for_approval"
              : null;
          if (request) seen.add(request.id);
          // Only recent identities are needed to avoid replaying overlapping requests.
          if (seen.size > 64) seen.delete(seen.values().next().value!);
          seenRequests.set(threadId, seen);
          if (activityIdentity(previous ?? null) === activityIdentity(next) && !phase) return;
          if (next) states.set(threadId, next);
          else states.delete(threadId);
          const attention: AgentAwarenessState | null =
            next && phase
              ? {
                  ...next,
                  phase,
                  headline: phase === "waiting_for_input" ? "Waiting for input" : "Approval needed",
                }
              : null;
          // Generation finishes after the phase update. Deliver its result even
          // inside the routine refresh interval; there may be no later event.
          const meaningfulUpdate =
            previous?.phase !== next?.phase || previous?.summary !== next?.summary;
          for (const record of records)
            yield* deliver(record, attention, false, meaningfulUpdate).pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "Direct APNs delivery failed; will reconcile on the next activity change or device registration.",
                ),
              ),
            );
        }),
      )
      .pipe(Effect.catch(() => Effect.logWarning("Could not publish direct agent activity.")));
  // Long turns emit no shell changes, so devices would otherwise read a working
  // agent as delayed. Routine delivery still applies its own interval.
  const refresh = () =>
    mutex
      .withPermit(
        Effect.gen(function* () {
          if (!transport.bundleId || records.length === 0) return;
          yield* hydrate;
          if (![...states.values()].some(isActive)) return;
          for (const record of records)
            yield* deliver(record, null).pipe(
              Effect.catch(() => Effect.logWarning("Direct APNs heartbeat delivery failed.")),
            );
        }),
      )
      .pipe(Effect.catch(() => Effect.logWarning("Could not refresh direct agent activity.")));
  const start = Effect.fn("DirectPush.start")(function* () {
    if (!transport.bundleId) return;
    if (Option.isSome(summaries))
      yield* forkParked(Stream.runForEach(summaries.value.changes, publishThread));
    yield* forkParked(
      refresh().pipe(
        Effect.repeat(Schedule.spaced(HEARTBEAT_INTERVAL)),
        Effect.delay(HEARTBEAT_INTERVAL),
      ),
    );
    yield* forkParked(
      Effect.gen(function* () {
        const events = query.streamDomainEvents;
        yield* mutex
          .withPermit(hydrate)
          .pipe(Effect.catch(() => Effect.logWarning("Direct push initial snapshot unavailable.")));
        const queued = new Set<ThreadId>();
        const worker = yield* makeDrainableWorker((threadId: ThreadId) => {
          queued.delete(threadId);
          return publishThread(threadId);
        });
        yield* events.pipe(
          Stream.runForEach((event) => {
            const threadId = eventThreadId(event);
            if (!threadId || !shouldPublishAgentAwarenessEvent(event) || queued.has(threadId))
              return Effect.void;
            queued.add(threadId);
            return worker.enqueue(threadId);
          }),
        );
      }),
    );
  });
  return DirectPush.of({
    status: Effect.fn("DirectPush.status")((id) =>
      status(id).pipe(Effect.mapError(operationError)),
    ),
    register: Effect.fn("DirectPush.register")((id, registration) =>
      register(id, registration).pipe(Effect.mapError(operationError)),
    ),
    unregister: Effect.fn("DirectPush.unregister")((id) =>
      unregister(id).pipe(Effect.mapError(operationError)),
    ),
    publishThread,
    refresh,
    start,
  });
});
export const layer = Layer.effect(DirectPush, make);
