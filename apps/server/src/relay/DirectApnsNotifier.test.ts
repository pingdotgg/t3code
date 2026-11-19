import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type PushDeviceRegistration,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as DirectApnsClient from "./DirectApnsClient.ts";
import * as DirectApnsDevices from "./DirectApnsDevices.ts";
import * as DirectApnsNotifier from "./DirectApnsNotifier.ts";

const NOW = "2026-09-04T12:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");

// Only the fields the awareness projection and the notifier read.
const shell = (overrides: Record<string, unknown>) =>
  ({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Fix the bug",
    modelSelection: { instanceId: "codex", model: "test-model" },
    lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
    status: "running",
    activityRunStatus: "running",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    settledOverride: null,
    archivedAt: null,
    updatedAt: DateTime.makeUnsafe(NOW),
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

const registration = (overrides: Partial<PushDeviceRegistration> = {}): PushDeviceRegistration => ({
  deviceId: "iphone",
  apnsToken: "a".repeat(64),
  apsEnvironment: "sandbox",
  bundleId: "com.example.t3code",
  platform: "ios",
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
  ...overrides,
});

const makeHarness = Effect.fnUntraced(function* (options: {
  readonly configured?: boolean;
  readonly domainEvents?: Stream.Stream<OrchestrationV2DomainEvent>;
  readonly respond?: (
    device: DirectApnsDevices.StoredPushDevice,
  ) => DirectApnsClient.DirectApnsSendResult;
}) {
  const currentShell = yield* Ref.make<OrchestrationV2ThreadShell | null>(shell({}));
  const reads: ThreadId[] = [];
  const firstRead = yield* Deferred.make<void>();
  const sent: Array<{ deviceId: string; title: string; body: string; phase: string }> = [];
  const values = new Map<string, Uint8Array>();
  const secrets = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
      set: (name, value) => Effect.sync(() => void values.set(name, value)),
      create: (name, value) => Effect.sync(() => void values.set(name, value)),
      remove: (name) => Effect.sync(() => void values.delete(name)),
      getOrCreateRandom: () => Effect.die("unused"),
    }),
  );
  const devicesLayer = DirectApnsDevices.layer.pipe(Layer.provide(secrets));
  const layer = DirectApnsNotifier.layer.pipe(
    Layer.provideMerge(devicesLayer),
    Layer.provide(
      Layer.succeed(
        DirectApnsClient.DirectApnsClient,
        DirectApnsClient.DirectApnsClient.of({
          isConfigured: Effect.succeed(options.configured ?? true),
          send: ({ device, notification }) =>
            Effect.sync(() => {
              sent.push({
                deviceId: device.deviceId,
                title: notification.title,
                body: notification.body,
                phase: notification.phase,
              });
              return options.respond?.(device) ?? { outcome: "sent" as const };
            }),
        }),
      ),
    ),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.sync(() => reads.push(threadId)).pipe(
            Effect.andThen(Ref.get(currentShell)),
            Effect.tap(() => Deferred.succeed(firstRead, undefined)),
          ),
        getShellSnapshot: () =>
          Ref.get(currentShell).pipe(
            Effect.map((current) => ({
              schemaVersion: 2,
              snapshotSequence: 1,
              threads: current === null ? [] : [current],
              archivedThreads: [],
            })),
          ) as never,
        streamDomainEvents: options.domainEvents ?? Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeed(Option.some({ id: PROJECT_ID, title: "Project" } as never)),
        snapshot: Effect.succeed({ projects: [{ id: PROJECT_ID, title: "Project" }] } as never),
      }),
    ),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env-1")),
        getDescriptor: Effect.die("unused"),
      } as never),
    ),
  );
  return { layer, currentShell, sent, reads, firstRead };
});

describe("DirectApnsNotifier", () => {
  it.effect("alerts every registered device on a transition, never on the first observation", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const harness = yield* makeHarness({});
      yield* Effect.gen(function* () {
        const notifier = yield* DirectApnsNotifier.DirectApnsNotifier;
        const devices = yield* DirectApnsDevices.DirectApnsDevices;
        yield* devices.register(registration());
        yield* devices.register(registration({ deviceId: "ipad", apnsToken: "b".repeat(64) }));

        yield* notifier.observeThread(THREAD_ID);
        yield* notifier.drain;
        assert.deepStrictEqual(harness.sent, []);

        yield* Ref.set(
          harness.currentShell,
          shell({ activityRunStatus: "completed", status: "completed" }),
        );
        yield* notifier.observeThread(THREAD_ID);
        yield* notifier.drain;
        assert.deepStrictEqual(
          harness.sent.map((push) => [push.deviceId, push.title, push.body, push.phase]).toSorted(),
          [
            ["ipad", "Fix the bug", "Done: Project", "completed"],
            ["iphone", "Fix the bug", "Done: Project", "completed"],
          ],
        );

        // Re-observing the same terminal state is not a new transition.
        yield* notifier.observeThread(THREAD_ID);
        yield* notifier.drain;
        assert.strictEqual(harness.sent.length, 2);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("skips devices whose preferences exclude the transition", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const harness = yield* makeHarness({});
      yield* Effect.gen(function* () {
        const notifier = yield* DirectApnsNotifier.DirectApnsNotifier;
        const devices = yield* DirectApnsDevices.DirectApnsDevices;
        yield* devices.register(registration({ notifyOnCompletion: false }));
        yield* devices.register(registration({ deviceId: "ipad", apnsToken: "b".repeat(64) }));
        yield* notifier.observeThread(THREAD_ID);
        yield* notifier.drain;
        yield* Ref.set(
          harness.currentShell,
          shell({ activityRunStatus: "completed", status: "completed" }),
        );
        yield* notifier.observeThread(THREAD_ID);
        yield* notifier.drain;
        assert.deepStrictEqual(
          harness.sent.map((push) => push.deviceId),
          ["ipad"],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("deletes a token APNs rejects as dead and keeps the other devices", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const harness = yield* makeHarness({
        respond: (device) =>
          device.deviceId === "iphone"
            ? { outcome: "rejected", status: 400, reason: "BadDeviceToken", removeToken: true }
            : { outcome: "sent" },
      });
      yield* Effect.gen(function* () {
        const notifier = yield* DirectApnsNotifier.DirectApnsNotifier;
        const devices = yield* DirectApnsDevices.DirectApnsDevices;
        yield* devices.register(registration());
        yield* devices.register(registration({ deviceId: "ipad", apnsToken: "b".repeat(64) }));
        yield* notifier.observeThread(THREAD_ID);
        yield* notifier.drain;
        yield* Ref.set(
          harness.currentShell,
          shell({ activityRunStatus: "failed", status: "failed" }),
        );
        yield* notifier.observeThread(THREAD_ID);
        yield* notifier.drain;
        assert.deepStrictEqual(
          (yield* devices.list).map((device) => device.deviceId),
          ["ipad"],
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("does nothing, and reads nothing, while APNs credentials are not configured", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      const harness = yield* makeHarness({ configured: false });
      yield* Effect.gen(function* () {
        const notifier = yield* DirectApnsNotifier.DirectApnsNotifier;
        const devices = yield* DirectApnsDevices.DirectApnsDevices;
        yield* devices.register(registration());
        yield* notifier.observeThread(THREAD_ID);
        yield* notifier.drain;
        yield* Ref.set(
          harness.currentShell,
          shell({ activityRunStatus: "completed", status: "completed" }),
        );
        yield* notifier.observeThread(THREAD_ID);
        yield* notifier.drain;
        assert.deepStrictEqual(harness.sent, []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("reads a thread only for events that can change its phase", () =>
    Effect.gen(function* () {
      const event = (type: string, threadId: ThreadId) =>
        ({ type, threadId, payload: {} }) as unknown as OrchestrationV2DomainEvent;
      const harness = yield* makeHarness({
        domainEvents: Stream.make(
          event("message.updated", ThreadId.make("chatty")),
          event("turn-item.updated", ThreadId.make("chatty")),
          event("run.updated", THREAD_ID),
        ),
      });
      yield* Effect.gen(function* () {
        const notifier = yield* DirectApnsNotifier.DirectApnsNotifier;
        yield* notifier.start();
        yield* Deferred.await(harness.firstRead);
        yield* notifier.drain;
        assert.deepStrictEqual(harness.reads, [THREAD_ID]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
