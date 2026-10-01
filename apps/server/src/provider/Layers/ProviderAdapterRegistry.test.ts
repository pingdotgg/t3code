import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { it, assert, vi } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ProviderAuthFlow from "../ProviderAuthFlow.ts";

import type * as ClaudeAdapter from "../Services/ClaudeAdapter.ts";
import type * as CodexAdapter from "../Services/CodexAdapter.ts";
import type * as CursorAdapter from "../Services/CursorAdapter.ts";
import type * as OpenCodeAdapter from "../Services/OpenCodeAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as ProviderAdapterRegistryLayer from "./ProviderAdapterRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

const fakeCodexAdapter: CodexAdapter.CodexAdapterShape = {
  provider: CODEX_DRIVER,
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  uploadFeedback: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeClaudeAdapter: ClaudeAdapter.ClaudeAdapterShape = {
  provider: CLAUDE_AGENT_DRIVER,
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeOpenCodeAdapter: OpenCodeAdapter.OpenCodeAdapterShape = {
  provider: OPENCODE_DRIVER,
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeCursorAdapter: CursorAdapter.CursorAdapterShape = {
  provider: CURSOR_DRIVER,
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const makeFakeInstance = (
  driverKindString: "codex" | "claudeAgent" | "cursor" | "opencode",
  adapter: ProviderInstance["adapter"],
): ProviderInstance => {
  const driverKind = ProviderDriverKind.make(driverKindString);
  return {
    instanceId: defaultInstanceIdForDriver(driverKind),
    driverKind,
    continuationIdentity: {
      driverKind,
      continuationKey: `${driverKind}:instance:${defaultInstanceIdForDriver(driverKind)}`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {
      resolveMaintenance: () =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({
            provider: driverKind,
            packageName: null,
          }),
        ),
      getSnapshot: Effect.succeed({} as unknown as ServerProvider),
      refresh: Effect.succeed({} as unknown as ServerProvider),
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
    },
    adapter,
    textGeneration: {} as unknown as TextGeneration.TextGeneration["Service"],
  };
};

const fakeInstances: ReadonlyArray<ProviderInstance> = [
  makeFakeInstance("codex", fakeCodexAdapter),
  makeFakeInstance("claudeAgent", fakeClaudeAdapter),
  makeFakeInstance("opencode", fakeOpenCodeAdapter),
  makeFakeInstance("cursor", fakeCursorAdapter),
];

const fakeInstanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(fakeInstances.find((instance) => instance.instanceId === instanceId)),
  listInstances: Effect.succeed(fakeInstances),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  // Tests never drive changes through this fake; acquire a throwaway
  // subscription on an unused PubSub so the shape is satisfied.
  subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) => PubSub.subscribe(pubsub)),
});

const layer = Layer.mergeAll(
  Layer.provide(
    ProviderAdapterRegistryLayer.ProviderAdapterRegistryLive,
    fakeInstanceRegistryLayer,
  ),
  NodeServices.layer,
);

it.layer(layer)("ProviderAdapterRegistryLive", (it) => {
  it("resolves adapters and routing metadata from provider instances", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
      const claudeInstanceId = defaultInstanceIdForDriver(CLAUDE_AGENT_DRIVER);

      const adapter = yield* registry.getByInstance(claudeInstanceId);
      assert.strictEqual(adapter, fakeClaudeAdapter);

      const info = yield* registry.getInstanceInfo(claudeInstanceId);
      assert.deepStrictEqual(info, {
        instanceId: claudeInstanceId,
        driverKind: CLAUDE_AGENT_DRIVER,
        displayName: undefined,
        accentColor: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: CLAUDE_AGENT_DRIVER,
          continuationKey: "claudeAgent:instance:claudeAgent",
        },
      });

      const instances = yield* registry.listInstances();
      assert.deepStrictEqual(instances, [
        defaultInstanceIdForDriver(CODEX_DRIVER),
        claudeInstanceId,
        defaultInstanceIdForDriver(OPENCODE_DRIVER),
        defaultInstanceIdForDriver(CURSOR_DRIVER),
      ]);
    }));
});

it.effect("blocks shared credential session startup and preserves guarded adapter identity", () =>
  Effect.gen(function* () {
    const target = fakeInstances[0]!;
    const peer = fakeInstances[1]!;
    const auth = yield* ProviderAuthFlow.make({
      instanceId: target.instanceId,
      credentialBinding: { owner: "t3", key: "shared-auth" },
      methods: Effect.succeed([
        { id: "browser", name: "Browser", description: null, type: "agent" },
      ]),
      authenticate: () => Effect.never,
      logout: Effect.void,
    });
    const peerAuth = yield* ProviderAuthFlow.make({
      instanceId: peer.instanceId,
      credentialBinding: { owner: "t3", key: "shared-auth" },
      methods: Effect.succeed([]),
      authenticate: () => Effect.void,
      logout: Effect.void,
    });
    const session = {
      threadId: ThreadId.make("new-session"),
      provider: peer.driverKind,
      providerInstanceId: peer.instanceId,
      status: "ready" as const,
      runtimeMode: "approval-required" as const,
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
    };
    const start = vi.fn(() => Effect.succeed(session));
    const instances = [
      { ...target, auth },
      { ...peer, auth: peerAuth, adapter: { ...peer.adapter, startSession: start } },
    ];
    const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry.pipe(
      Effect.provide(
        ProviderAdapterRegistryLayer.ProviderAdapterRegistryLive.pipe(
          Layer.provide(
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: (id) =>
                Effect.succeed(instances.find((instance) => instance.instanceId === id)),
              listInstances: Effect.succeed(instances),
            }),
          ),
        ),
      ),
    );
    const guarded = yield* registry.getByInstance(peer.instanceId);
    assert.strictEqual(yield* registry.getByInstance(peer.instanceId), guarded);
    const flow = yield* auth.start("owner");
    const error = yield* guarded
      .startSession({
        threadId: session.threadId,
        providerInstanceId: peer.instanceId,
        runtimeMode: "approval-required",
      })
      .pipe(Effect.flip);
    assert.strictEqual(error._tag, "ProviderAdapterValidationError");
    assert.strictEqual(start.mock.calls.length, 0);
    yield* auth.cancel("owner", flow.flowId!);
    assert.deepStrictEqual(
      yield* guarded.startSession({
        threadId: session.threadId,
        providerInstanceId: peer.instanceId,
        runtimeMode: "approval-required",
      }),
      session,
    );
    assert.strictEqual(start.mock.calls.length, 1);
    const entered = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    start.mockImplementation(() =>
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        return yield* Effect.never;
      }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
    );
    const startup = yield* guarded
      .startSession({
        threadId: session.threadId,
        providerInstanceId: peer.instanceId,
        runtimeMode: "approval-required",
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    // Signing out through another instance must drain its peer's startup too.
    yield* auth.logout(Effect.void);
    yield* Deferred.await(stopped);
    assert.strictEqual(Exit.isFailure(yield* Fiber.await(startup)), true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
