import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  RunId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import type { ConnectionCatalogEntry } from "../../../../packages/client-runtime/src/connection/catalog";
import * as EnvironmentRegistry from "../../../../packages/client-runtime/src/connection/registry";
import * as EnvironmentSupervisor from "../../../../packages/client-runtime/src/connection/supervisor";
import {
  type PreparedConnection,
  type NetworkStatus,
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
} from "../../../../packages/client-runtime/src/connection/model";
import * as Persistence from "../../../../packages/client-runtime/src/platform/persistence";
import type { RpcSession } from "../../../../packages/client-runtime/src/rpc/session";
import type { WsRpcProtocolClient } from "../../../../packages/client-runtime/src/rpc/protocol";
import * as ThreadSnapshotLoader from "../../../../packages/client-runtime/src/state/threadSnapshotHttp";
import {
  v2Now,
  v2Projection,
  v2ShellSnapshot,
  v2ThreadShell,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import {
  resolvePendingThreadCreation,
  type PendingThreadCreation,
} from "./pending-thread-creation";
import type { QueuedThreadMessage } from "./thread-outbox-model";

vi.mock("../connection/runtime", () => ({
  get connectionAtomRuntime() {
    return runtime;
  },
}));
vi.mock("../connection/catalog", () => ({
  environmentCatalog: { catalogValueAtom: Atom.make({ isReady: true, entries: new Map() }) },
}));
vi.mock("./shell", () => ({ environmentSnapshotAtom: () => shell }));
vi.mock("./thread-outbox", () => ({
  threadOutboxManager: { queuedMessagesByThreadKeyAtom: queued },
}));

const environmentId = EnvironmentId.make("environment-1");
const ref = { environmentId, threadId: v2Projection.thread.id };
const key = `${environmentId}:${ref.threadId}`;
const shell = Atom.make<OrchestrationV2ShellSnapshot | null>(null);
const queued = Atom.make<Record<string, ReadonlyArray<QueuedThreadMessage>>>({});
let runtime: Atom.AtomRuntime<
  | EnvironmentRegistry.EnvironmentRegistry
  | Persistence.EnvironmentCacheStore
  | ThreadSnapshotLoader.ThreadSnapshotLoader,
  never
>;
const creation: QueuedThreadMessage = {
  ...ref,
  commandId: CommandId.make("create"),
  messageId: MessageId.make("prompt"),
  text: "Inspect this image",
  attachments: [
    {
      id: "image",
      type: "image",
      name: "IMG_0395.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 10,
      previewUri: "file:///image.jpg",
    },
  ],
  modelSelection: v2ThreadShell.modelSelection,
  createdAt: "2026-10-06T20:37:12.000Z",
  creation: {
    projectId: v2ThreadShell.projectId,
    workspaceMode: "local",
    branch: null,
    worktreePath: null,
  },
};

const makeHarness = Effect.fn("MobileThreadTest.makeHarness")(function* () {
  let projection: OrchestrationV2ThreadProjection | null = null;
  let loads = 0;
  const subscriptions = yield* Queue.unbounded<{
    events: Queue.Queue<OrchestrationV2ThreadStreamItem>;
    closed: Deferred.Deferred<void>;
  }>();
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: "Test",
    httpBaseUrl: "https://test.invalid",
    wsBaseUrl: "wss://test.invalid",
  });
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
          const closed = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
          yield* Queue.offer(subscriptions, { events, closed });
          return Stream.fromQueue(events);
        }),
      ),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({ threadResumeCompletionMarker: true } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some({
        environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: target.wsBaseUrl,
        httpAuthorization: null,
        target,
      }),
    ),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const registryService = EnvironmentRegistry.EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(),
    ),
    networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
    start: Effect.void,
    register: () => Effect.die("Unexpected register"),
    registerPlatform: () => Effect.die("Unexpected register"),
    reconcilePlatform: () => Effect.die("Unexpected reconcile"),
    remove: () => Effect.die("Unexpected remove"),
    removeRoute: () => Effect.die("Unexpected remove"),
    reorderRoutes: () => Effect.die("Unexpected reorder"),
    removeRelayEnvironments: () => Effect.die("Unexpected remove"),
    retryNow: () => Effect.void,
    setEnabled: () => Effect.die("Unexpected toggle"),
    setCompatibility: () => Effect.die("Unexpected compatibility"),
    state: () => SubscriptionRef.get(supervisor.state),
    stateChanges: () => SubscriptionRef.changes(supervisor.state),
    run: (_id, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    runStream: (_id, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_id, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  });
  runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registryService),
      Layer.succeed(
        Persistence.EnvironmentCacheStore,
        Persistence.EnvironmentCacheStore.of({
          loadShell: () => Effect.succeedNone,
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeedNone,
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadServerConfig: () => Effect.succeedNone,
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeedNone,
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        }),
      ),
      Layer.succeed(
        ThreadSnapshotLoader.ThreadSnapshotLoader,
        ThreadSnapshotLoader.ThreadSnapshotLoader.of({
          load: () =>
            Effect.sync(() => {
              loads += 1;
              return projection === null
                ? { _tag: "missing" as const }
                : { _tag: "present" as const, snapshot: { snapshotSequence: 1, projection } };
            }),
        }),
      ),
    ),
  );
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make({ defaultIdleTTL: 60_000, timeoutResolution: 1 })),
    (registry) => Effect.sync(() => registry.dispose()),
  );
  vi.resetModules();
  const { environmentThreadDetails } = yield* Effect.promise(() => import("./threads"));
  const { pendingThreadCreationOutcomesAtom } = yield* Effect.promise(
    () => import("./pending-thread-creation"),
  );
  return {
    registry,
    details: environmentThreadDetails,
    outcomes: pendingThreadCreationOutcomesAtom,
    subscriptions,
    loads: () => loads,
    setProjection: (value: OrchestrationV2ThreadProjection) => {
      projection = value;
    },
  };
});

describe("mobile creation detail subscriptions", () => {
  it.effect.each(["shell", "delivery"] as const)(
    "holds detail readers until %s, then retires setup through run completion and remount",
    (confirmation) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.registry.set(queued, { [key]: [creation] });
        let previous: PendingThreadCreation | null = { message: creation, outcome: null };
        const state = h.details.stateAtom(ref);
        const readers = [
          h.details.threadAtom(ref),
          h.details.queueWorkflowAtom(ref),
          h.details.queuedCountAtom(ref),
          h.details.turnSubagentsAtom(ref),
        ];
        const unmounts = readers.map((atom) => h.registry.mount(atom as Atom.Atom<unknown>));
        // The raw state machine returns a definitive missing snapshot if any reader
        // bypasses the creation gate. Observe its settled state, not a timed sleep.
        yield* AtomRegistry.toStream(h.registry, state).pipe(
          Stream.filter((value) => value.status === "empty" || value.status === "deleted"),
          Stream.runHead,
        );
        expect(h.loads()).toBe(0);
        expect(h.registry.get(state).status).toBe("empty");
        previous = resolvePendingThreadCreation({
          threadKey: key,
          pending: previous,
          previous: null,
          detail: Option.getOrNull(h.registry.get(state).data),
        });
        expect(previous).not.toBeNull();

        h.setProjection(v2Projection);
        if (confirmation === "shell") {
          h.registry.set(shell, v2ShellSnapshot);
        } else {
          h.registry.set(h.outcomes, { [key]: { kind: "delivered", message: creation } });
        }
        const subscription = yield* Queue.take(h.subscriptions);
        yield* Queue.offer(subscription.events, { kind: "synchronized" });
        yield* AtomRegistry.toStream(h.registry, state).pipe(
          Stream.filter((value) => value.status === "live"),
          Stream.runHead,
        );
        expect(h.loads()).toBe(1);
        const delivered: PendingThreadCreation = {
          message: creation,
          outcome: { kind: "delivered", message: creation },
        };
        h.registry.set(h.outcomes, { [key]: delivered.outcome! });
        h.registry.set(queued, {});
        h.registry.set(shell, v2ShellSnapshot);
        previous = resolvePendingThreadCreation({
          threadKey: key,
          pending: delivered,
          previous,
          detail: Option.getOrNull(h.registry.get(state).data),
        });
        expect(previous).not.toBeNull();

        const runId = RunId.make("run-1");
        for (const status of ["running", "completed"] as const) {
          const projection: OrchestrationV2ThreadProjection = {
            ...v2Projection,
            messages: [
              {
                id: creation.messageId,
                threadId: ref.threadId,
                role: "user",
                text: creation.text,
                attachments: [],
                createdBy: "user",
                creationSource: "mobile",
                runId,
                nodeId: null,
                streaming: false,
                createdAt: v2Now,
                updatedAt: v2Now,
              },
            ],
            runs: [
              {
                id: runId,
                threadId: ref.threadId,
                status,
                ordinal: 1,
                providerInstanceId: v2ThreadShell.providerInstanceId,
                modelSelection: v2ThreadShell.modelSelection,
                providerThreadId: null,
                userMessageId: creation.messageId,
                rootNodeId: null,
                activeAttemptId: null,
                checkpointId: null,
                contextHandoffId: null,
                requestedAt: v2Now,
                startedAt: v2Now,
                completedAt: status === "completed" ? v2Now : null,
              },
            ],
          };
          h.setProjection(projection);
          yield* Queue.offer(subscription.events, {
            kind: "snapshot",
            snapshotSequence: status === "running" ? 2 : 3,
            projection,
          });
          yield* AtomRegistry.toStream(h.registry, state).pipe(
            Stream.filter((value) => Option.getOrNull(value.data)?.runs[0]?.status === status),
            Stream.runHead,
          );
          h.registry.set(h.outcomes, {});
          previous = resolvePendingThreadCreation({
            threadKey: key,
            pending: null,
            previous,
            detail: Option.getOrNull(h.registry.get(state).data),
          });
          expect(previous).toBeNull();
        }
        for (const unmount of unmounts) unmount();
        yield* Deferred.await(subscription.closed);
        const unmount = h.registry.mount(h.details.threadAtom(ref));
        const resumed = yield* Queue.take(h.subscriptions);
        yield* Queue.offer(resumed.events, { kind: "synchronized" });
        yield* AtomRegistry.toStream(h.registry, state).pipe(
          Stream.filter((value) => value.status === "live"),
          Stream.runHead,
        );
        expect(Option.getOrThrow(h.registry.get(state).data).runs[0]?.status).toBe("completed");
        expect(
          resolvePendingThreadCreation({
            threadKey: key,
            pending: null,
            previous,
            detail: Option.getOrNull(h.registry.get(state).data),
          }),
        ).toBeNull();
        unmount();
      }),
  );

  it.effect("keeps failed creations recoverable without requesting a missing thread", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const failed: PendingThreadCreation = {
        message: creation,
        outcome: { kind: "failed", message: creation, reason: "Creation rejected" },
      };
      h.registry.set(h.outcomes, { [key]: failed.outcome! });
      const state = h.details.stateAtom(ref);
      const unmount = h.registry.mount(h.details.threadAtom(ref));
      expect(h.registry.get(state).status).toBe("empty");
      expect(h.loads()).toBe(0);
      expect(
        resolvePendingThreadCreation({
          threadKey: key,
          pending: failed,
          previous: null,
          detail: Option.getOrNull(h.registry.get(state).data),
        }),
      ).toBe(failed);
      unmount();
    }),
  );

  it.effect("still loads existing routes without an outbox creation or shell", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.setProjection(v2Projection);
      const state = h.details.stateAtom(ref);
      const unmount = h.registry.mount(h.details.threadAtom(ref));
      const subscription = yield* Queue.take(h.subscriptions);
      yield* Queue.offer(subscription.events, { kind: "synchronized" });
      yield* AtomRegistry.toStream(h.registry, state).pipe(
        Stream.filter((value) => value.status === "live"),
        Stream.runHead,
      );
      expect(h.loads()).toBe(1);
      expect(Option.getOrNull(h.registry.get(state).data)).toEqual(v2Projection);
      unmount();
    }),
  );
});
