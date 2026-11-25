// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto cannot generate EC key pairs.
import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import {
  type DirectPushApsEnvironment,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import type { AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as DirectPush from "./DirectPush.ts";
import * as DirectPushApns from "./DirectPushApns.ts";

const THREAD_ID = ThreadId.make("push-thread");
const PROJECT_ID = ProjectId.make("push-project");
const NOW = "2026-11-12T12:00:00.000Z";

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Fix the build",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "running",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: DateTime.makeUnsafe(NOW),
    updatedAt: DateTime.makeUnsafe(NOW),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const project = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/workspace",
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

const pem = (namedCurve: string) =>
  NodeCrypto.generateKeyPairSync("ec", { namedCurve })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();

interface Delivery {
  readonly environment: DirectPushApsEnvironment;
  readonly payload: DirectPushApns.ApnsAlertPayload;
}

const makeHarness = Effect.fn(function* (
  respond: (environment: DirectPushApsEnvironment) => DirectPushApns.ApnsResponse = () => ({
    status: 200,
    reason: null,
  }),
) {
  const values = new Map<string, Uint8Array>();
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    remove: (name) => Effect.sync(() => void values.delete(name)),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  const currentShell = yield* Ref.make<OrchestrationV2ThreadShell>(shell());
  const deliveries: Array<Delivery> = [];
  const apns = DirectPushApns.DirectPushApns.of({
    send: (input) =>
      Effect.sync(() => {
        deliveries.push({ environment: input.environment, payload: input.payload });
        return respond(input.environment);
      }),
  });
  const service = yield* DirectPush.make.pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.provideService(DirectPushApns.DirectPushApns, apns),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getAgentAwarenessSnapshot: () =>
            Ref.get(currentShell).pipe(
              Effect.map((thread) => ({ snapshotSequence: 1, threads: [thread] })),
            ),
          streamDomainEvents: Stream.empty,
        }),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedSome(project) }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("push-environment")),
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("push-environment"),
            label: "Studio Mac",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: false },
          }),
        }),
      ),
    ),
  );
  const configure = (apsEnvironment: DirectPushApsEnvironment = "production") =>
    Effect.gen(function* () {
      yield* service.setCredentials({
        teamId: "TEAM",
        keyId: "KEY",
        privateKey: pem("prime256v1"),
      });
      yield* service.registerDevice({
        deviceId: "phone",
        label: "iPhone",
        token: "a".repeat(64),
        bundleId: "net.example.t3code",
        apsEnvironment,
      });
    });
  const observe = (thread: OrchestrationV2ThreadShell) =>
    Ref.set(currentShell, thread).pipe(Effect.andThen(service.observeThread(THREAD_ID)));
  return { service, deliveries, configure, observe };
});

describe("directPushAlertFor", () => {
  const rows: ReadonlyArray<
    readonly [
      AgentAwarenessPhase | undefined,
      AgentAwarenessPhase,
      DirectPush.DirectPushAlertDecision,
    ]
  > = [
    [undefined, "completed", null],
    [undefined, "waiting_for_approval", null],
    ["running", "waiting_for_approval", "alert"],
    ["starting", "waiting_for_input", "alert"],
    ["waiting_for_approval", "waiting_for_input", null],
    ["completed", "waiting_for_input", "alert"],
    ["running", "failed", "alert"],
    ["completed", "failed", null],
    ["running", "completed", "hold"],
    ["waiting_for_approval", "completed", "hold"],
    ["failed", "completed", null],
    ["completed", "running", null],
  ];
  it.each(rows)("%s → %s is %s", (previous, next, expected) => {
    assert.equal(DirectPush.directPushAlertFor(previous, next), expected);
  });
});

describe("DirectPush", () => {
  it.effect("holds a completion through a continuation gap, then alerts it once", () =>
    Effect.gen(function* () {
      const { service, deliveries, configure, observe } = yield* makeHarness();
      yield* configure();
      yield* observe(shell());
      yield* observe(shell({ status: "completed" }));
      yield* observe(shell());
      yield* TestClock.adjust("5 seconds");
      yield* service.drain;
      assert.equal(deliveries.length, 0);

      yield* observe(shell({ status: "completed" }));
      yield* TestClock.adjust("5 seconds");
      yield* service.drain;
      assert.deepEqual(
        deliveries.map((delivery) => delivery.payload),
        [
          {
            aps: {
              alert: { title: "Fix the build", body: "Agent finished: Project" },
              sound: "default",
              "thread-id": `push-environment/${THREAD_ID}`,
            },
            body: {
              environmentId: "push-environment",
              threadId: THREAD_ID,
              deepLink: `/threads/push-environment/${THREAD_ID}`,
            },
          },
        ],
      );
    }),
  );

  it.effect("alerts an approval at once and stays quiet without devices", () =>
    Effect.gen(function* () {
      const { service, deliveries, configure, observe } = yield* makeHarness();
      const waiting = shell({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request"),
          kind: "command",
          createdAt: DateTime.makeUnsafe(NOW),
        },
      });
      yield* observe(shell());
      yield* observe(waiting);
      yield* service.drain;
      assert.equal(deliveries.length, 0);

      yield* configure();
      yield* observe(shell());
      yield* observe(waiting);
      yield* service.drain;
      assert.deepEqual(
        deliveries.map((delivery) => delivery.payload.aps.alert.body),
        ["Approval needed: Project"],
      );
    }),
  );

  it.effect("moves a device to the APNs environment that accepts its token", () =>
    Effect.gen(function* () {
      const { service, deliveries, configure } = yield* makeHarness((environment) =>
        environment === "production"
          ? { status: 400, reason: "BadDeviceToken" }
          : { status: 200, reason: null },
      );
      yield* configure("production");
      const result = yield* service.sendTest;
      assert.deepEqual(result.deliveries, [
        { deviceId: "phone", label: "iPhone", ok: true, error: null },
      ]);
      assert.deepEqual(
        deliveries.map((delivery) => delivery.environment),
        ["production", "sandbox"],
      );
      const status = yield* service.getStatus;
      assert.equal(status.devices[0]?.apsEnvironment, "sandbox");

      yield* service.sendTest;
      assert.deepEqual(
        deliveries.map((delivery) => delivery.environment),
        ["production", "sandbox", "sandbox"],
      );
    }),
  );

  it.effect("drops a device APNs reports as unregistered", () =>
    Effect.gen(function* () {
      const { service, configure } = yield* makeHarness(() => ({
        status: 410,
        reason: "Unregistered",
      }));
      yield* configure();
      const result = yield* service.sendTest;
      assert.deepEqual(result.deliveries, [
        { deviceId: "phone", label: "iPhone", ok: false, error: "Unregistered" },
      ]);
      assert.deepEqual((yield* service.getStatus).devices, []);
    }),
  );

  it.effect("rejects a key that is not an APNs P-256 key", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const error = yield* service
        .setCredentials({ teamId: "TEAM", keyId: "KEY", privateKey: pem("secp384r1") })
        .pipe(Effect.flip);
      assert.equal(error.reason, "invalid-credentials");
      assert.equal((yield* service.getStatus).credentials, null);
    }),
  );
});
