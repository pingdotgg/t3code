import { it, expect } from "@effect/vitest";
import { Effect, Layer, Option, Schema, DateTime } from "effect";
import { TestClock } from "effect/testing";
import {
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  RuntimeRequestId,
  AuthOrchestrationReadScope,
  type DirectPushRegistration,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { ActivitySummaries } from "../pseudocode/ActivitySummaries.ts";
import { DirectPush, make } from "./DirectPush.ts";
import { ApnsTransport, type ApnsRequest, type ApnsResult } from "./ApnsTransport.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { AuthSessionRecord, AuthSessionRepository } from "../persistence/AuthSessions.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { aggregateActivity, liveActivityPayload } from "./payloads.ts";

const sessionId = AuthSessionId.make("session");
const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const now = "2026-09-06T12:00:00.000Z";
const registration: DirectPushRegistration = {
  deviceId: "phone",
  bundleId: "test.app",
  apsEnvironment: "production",
  pushToken: "aabb",
  activityToken: "ccdd",
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
};

const activeSession = Schema.decodeSync(AuthSessionRecord)({
  sessionId,
  subject: "user",
  scopes: [AuthOrchestrationReadScope],
  method: "bearer-access-token",
  client: {
    label: null,
    ipAddress: null,
    userAgent: null,
    deviceType: "mobile",
    os: "iOS",
    browser: null,
  },
  issuedAt: now,
  expiresAt: "2099-01-01T00:00:00.000Z",
  lastConnectedAt: null,
  revokedAt: null,
});

function harness() {
  let thread: OrchestrationV2ThreadShell = {
    id: threadId,
    projectId,
    title: "Fix notifications",
    pullRequests: [],
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    createdBy: "user",
    creationSource: "web",
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    activeRunId: null,
    latestRunId: RunId.make("run"),
    latestVisibleMessage: null,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    status: "running",
    pendingRuntimeRequest: null,
    latestRunStartedAt: DateTime.makeUnsafe(now),
    createdAt: DateTime.makeUnsafe(now),
    updatedAt: DateTime.makeUnsafe(now),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: DateTime.makeUnsafe(now),
    hasActionableProposedPlan: false,
  };
  const project = {
    id: projectId,
    title: "Project",
    workspaceRoot: "/test",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const requests: ApnsRequest[] = [];
  let result: ApnsResult = { status: 200 };
  let revoked = false;
  let summary: string | undefined;
  const secrets = new Map<string, Uint8Array>();
  const layer = Layer.effect(DirectPush, make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ActivitySummaries)({
          enrich: ({ state }) => Effect.succeed({ ...state, ...(summary ? { summary } : {}) }),
        }),
        Layer.succeed(ApnsTransport, {
          bundleId: "test.app",
          send: (request) =>
            Effect.sync(() => {
              requests.push(request);
              return result;
            }),
        }),
        Layer.mock(ServerSecretStore)({
          get: (key) => Effect.sync(() => Option.fromNullishOr(secrets.get(key))),
          set: (key, value) =>
            Effect.sync(() => {
              secrets.set(key, value);
            }),
        }),
        Layer.mock(AuthSessionRepository)({
          getById: () => Effect.sync(() => (revoked ? Option.none() : Option.some(activeSession))),
        }),
        Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) }),
        Layer.mock(ThreadManagementService)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              archivedThreads: [],
              threads: [thread],
            }),
          getThreadShell: () => Effect.sync(() => thread),
        }),
        Layer.mock(ProjectService)({
          snapshot: Effect.succeed({ projects: [project], updatedAt: now }),
          getById: () => Effect.succeedSome(project),
        }),
      ),
    ),
  );
  let pendingInput: OrchestrationV2ThreadShell["pendingRuntimeRequest"] = null;
  let pendingApproval: OrchestrationV2ThreadShell["pendingRuntimeRequest"] = null;
  let requestNumber = 0;
  return {
    layer,
    requests,
    secrets,
    summarize: (value: string) => {
      summary = value;
    },
    change: (
      patch: Partial<OrchestrationV2ThreadShell> & { input?: boolean; approval?: boolean },
    ) => {
      const { input, approval, ...fields } = patch;
      if (input !== undefined)
        pendingInput = input
          ? (pendingInput ?? {
              id: RuntimeRequestId.make(`input:${++requestNumber}`),
              kind: "user_input",
              createdAt: DateTime.makeUnsafe(now),
            })
          : null;
      if (approval !== undefined)
        pendingApproval = approval
          ? (pendingApproval ?? {
              id: RuntimeRequestId.make(`approval:${++requestNumber}`),
              kind: "command",
              createdAt: DateTime.makeUnsafe(now),
            })
          : null;
      thread = { ...thread, ...fields, pendingRuntimeRequest: pendingApproval ?? pendingInput };
    },
    revoke: () => {
      revoked = true;
    },
    response: (next: ApnsResult) => {
      result = next;
    },
  };
}

it.effect(
  "reconciles silently on registration and alerts once for each new attention phase",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const push = yield* DirectPush;
      expect((yield* push.register(sessionId, registration)).registered).toBe(true);
      expect(h.requests.some((request) => request.kind === "alert")).toBe(false);
      h.change({ input: true });
      yield* push.publishThread(threadId);
      yield* push.publishThread(threadId);
      h.change({
        title: "Renamed thread",
        updatedAt: DateTime.makeUnsafe("2026-09-06T12:01:00.000Z"),
      });
      yield* push.publishThread(threadId);
      expect(h.requests.filter((request) => request.kind === "alert")).toHaveLength(1);
      h.change({ input: false });
      yield* push.publishThread(threadId);
      h.change({ input: true });
      yield* push.publishThread(threadId);
      expect(h.requests.filter((request) => request.kind === "alert")).toHaveLength(2);
      const alert = h.requests.find((request) => request.kind === "alert")!;
      expect(alert.payload).toMatchObject({
        aps: { sound: "default", "content-available": 1 },
        environmentId,
        threadId,
        directWidget: { environmentId, attentionCount: 1, approvalCount: 0, activeProjectCount: 1 },
      });
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("does not send to revoked sessions and removes their persisted registrations", () => {
  const h = harness();
  return Effect.gen(function* () {
    const push = yield* DirectPush;
    yield* push.register(sessionId, registration);
    h.requests.length = 0;
    h.revoke();
    h.change({ approval: true });
    yield* push.publishThread(threadId);
    expect(h.requests).toEqual([]);
    expect((yield* push.status(sessionId)).registered).toBe(false);
  }).pipe(Effect.provide(h.layer));
});

it.effect("does not replay an input alert when an overlapping approval resolves", () => {
  const h = harness();
  return Effect.gen(function* () {
    const push = yield* DirectPush;
    yield* push.register(sessionId, registration);
    h.change({ input: true });
    yield* push.publishThread(threadId);
    h.change({ approval: true });
    yield* push.publishThread(threadId);
    h.change({ approval: false });
    yield* push.publishThread(threadId);
    expect(h.requests.filter((request) => request.kind === "alert")).toHaveLength(2);
  }).pipe(Effect.provide(h.layer));
});

it.effect("rejects mismatched bundle IDs and ends activities when disabled or unregistered", () => {
  const h = harness();
  return Effect.gen(function* () {
    const push = yield* DirectPush;
    expect(
      (yield* push.register(sessionId, { ...registration, bundleId: "wrong.app" })).registered,
    ).toBe(false);
    expect(h.requests).toEqual([]);
    yield* push.register(sessionId, registration);
    h.requests.length = 0;
    yield* push.register(sessionId, {
      ...registration,
      liveActivitiesEnabled: false,
      activityToken: null,
    });
    expect(h.requests.find((request) => request.kind === "liveactivity")?.payload).toMatchObject({
      aps: { event: "end" },
    });
    yield* push.unregister(sessionId);
    expect((yield* push.status(sessionId)).registered).toBe(false);
  }).pipe(Effect.provide(h.layer));
});

it.effect("clears invalid tokens without retrying permanent APNs rejections", () => {
  const h = harness();
  return Effect.gen(function* () {
    const push = yield* DirectPush;
    h.response({ status: 410, reason: "Unregistered" });
    yield* push.register(sessionId, registration);
    expect(h.requests).toHaveLength(2);
    h.requests.length = 0;
    h.change({ input: true });
    yield* push.publishThread(threadId);
    expect(h.requests).toEqual([]);
  }).pipe(Effect.provide(h.layer));
});

it("bounds ActivityKit payload bytes with Unicode titles and uses the right layout", () => {
  const aggregate = aggregateActivity(
    Array.from({ length: 3 }, (_, index) => ({
      environmentId,
      threadId: ThreadId.make(`thread-${index}`),
      projectTitle: "😀".repeat(200),
      threadTitle: "😀".repeat(200),
      modelTitle: "😀".repeat(200),
      phase: "running" as const,
      headline: "Working",
      updatedAt: now,
      deepLink: "/threads/test",
    })),
    now,
  );
  const payload = liveActivityPayload(
    aggregate,
    1234,
    false,
    `DirectAgentActivity:${environmentId}`,
  );
  expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(4096);
  expect(payload.aps["content-state"].name).toBe(`DirectAgentActivity:${environmentId}`);
});

it.effect(
  "delivers a generated summary after the immediate phase push, without another phase change",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      const push = yield* DirectPush;
      yield* push.register(sessionId, registration);
      h.requests.length = 0;
      h.summarize("Checking notification delivery retries.");
      yield* push.publishThread(threadId);
      const updates = h.requests.filter((request) => request.kind === "background");
      expect(updates).toHaveLength(1);
      expect(updates[0]?.payload).toMatchObject({
        directWidget: {
          activity: {
            activities: [{ summary: "Checking notification delivery retries." }],
          },
        },
      });
      yield* push.publishThread(threadId);
      expect(h.requests.filter((request) => request.kind === "background")).toHaveLength(1);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("sends the final summary after the live activity has ended", () => {
  const h = harness();
  return Effect.gen(function* () {
    const push = yield* DirectPush;
    yield* push.register(sessionId, registration);
    h.change({
      status: "completed",
      latestRunCompletedAt: DateTime.makeUnsafe(now),
    });
    yield* push.publishThread(threadId);
    h.requests.length = 0;
    h.summarize("Fixed retries and verified notification delivery.");
    yield* push.publishThread(threadId);
    expect(h.requests.filter((request) => request.kind === "liveactivity")).toHaveLength(0);
    expect(h.requests.find((request) => request.kind === "background")?.payload).toMatchObject({
      directWidget: {
        activity: {
          activities: [
            { phase: "completed", summary: "Fixed retries and verified notification delivery." },
          ],
        },
      },
    });
  }).pipe(Effect.provide(h.layer));
});

it.effect("heartbeats the widget while an agent is active and stays quiet when idle", () => {
  const h = harness();
  return Effect.gen(function* () {
    const push = yield* DirectPush;
    yield* push.register(sessionId, registration);
    h.requests.length = 0;
    yield* push.refresh();
    expect(h.requests.filter((request) => request.kind === "background")).toHaveLength(0);
    yield* TestClock.adjust("10 minutes");
    yield* push.refresh();
    expect(h.requests.filter((request) => request.kind === "background")).toHaveLength(1);
    expect(h.requests.find((request) => request.kind === "liveactivity")?.payload).toMatchObject({
      aps: { event: "update" },
    });
    h.change({
      status: "idle",
      latestRunId: null,
      updatedAt: DateTime.makeUnsafe("2026-09-06T12:10:00.000Z"),
    });
    yield* push.publishThread(threadId);
    h.requests.length = 0;
    yield* TestClock.adjust("10 minutes");
    yield* push.refresh();
    expect(h.requests).toEqual([]);
  }).pipe(Effect.provide(h.layer));
});

it.effect("reports Apple's last delivery result for the device in status", () => {
  const h = harness();
  return Effect.gen(function* () {
    const push = yield* DirectPush;
    expect((yield* push.status(sessionId)).lastDelivery).toBeUndefined();
    h.response({ status: 403, reason: "BadEnvironmentKeyInToken" });
    yield* push.register(sessionId, registration);
    expect((yield* push.status(sessionId)).lastDelivery).toEqual({
      at: "1970-01-01T00:00:00.000Z",
      kind: "liveactivity",
      status: 403,
      reason: "BadEnvironmentKeyInToken",
    });
    h.response({ status: 200 });
    h.change({ input: true });
    yield* push.publishThread(threadId);
    expect((yield* push.status(sessionId)).lastDelivery).toMatchObject({
      status: 200,
      reason: null,
    });
    yield* push.unregister(sessionId);
    expect((yield* push.status(sessionId)).lastDelivery).toBeUndefined();
  }).pipe(Effect.provide(h.layer));
});
