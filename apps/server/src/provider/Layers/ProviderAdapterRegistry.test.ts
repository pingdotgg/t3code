import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { it, assert, vi } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import type { ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { CursorAdapter } from "../Services/CursorAdapter.ts";
import type { CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderAdapterRegistryLive } from "./ProviderAdapterRegistry.ts";
import { ProviderUnsupportedError } from "../Errors.ts";
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

const fakeOpenCodeAdapter: OpenCodeAdapterShape = {
  provider: "opencode",
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

const fakeCursorAdapter: CursorAdapterShape = {
  provider: "cursor",
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

// ProviderAdapterRegistryLive is now a facade over ProviderInstanceRegistry —
// it walks `listInstances` once at boot and surfaces the default-instance
// adapter keyed by its driver kind. To test the facade we supply four fake
// instances whose `instanceId === defaultInstanceIdForDriver(driverKind)` so
// they pass the default-instance filter.
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
      maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
        provider: driverKind,
        packageName: null,
      }),
      getSnapshot: Effect.succeed({} as unknown as ServerProvider),
      refresh: Effect.succeed({} as unknown as ServerProvider),
      streamChanges: Stream.empty,
    },
    adapter,
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration: {} as unknown as TextGenerationShape,
  };
};

const fakeInstances: ReadonlyArray<ProviderInstance> = [
  makeFakeInstance("codex", fakeCodexAdapter),
  makeFakeInstance("claudeAgent", fakeClaudeAdapter),
  makeFakeInstance("opencode", fakeOpenCodeAdapter),
  makeFakeInstance("cursor", fakeCursorAdapter),
];

const fakeInstanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry, {
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
  Layer.provide(ProviderAdapterRegistryLive, fakeInstanceRegistryLayer),
  NodeServices.layer,
);

it.layer(layer)("ProviderAdapterRegistryLive", (it) => {
  it("resolves adapters and routing metadata from provider instances", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const codex = yield* registry.getByProvider("codex");
      const claude = yield* registry.getByProvider("claudeAgent");
      const openCode = yield* registry.getByProvider("opencode");
      const cursor = yield* registry.getByProvider("cursor");
      assert.equal(codex, fakeCodexAdapter);
      assert.equal(claude, fakeClaudeAdapter);
      assert.equal(openCode, fakeOpenCodeAdapter);
      assert.equal(cursor, fakeCursorAdapter);

      const providers = yield* registry.listProviders();
      assert.deepEqual(providers, ["codex", "claudeAgent", "opencode", "cursor"]);
    }),
  );

  it.effect("fails with ProviderUnsupportedError for unknown providers", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const adapter = yield* registry.getByProvider("unknown" as ProviderKind).pipe(Effect.result);
      assertFailure(adapter, new ProviderUnsupportedError({ provider: "unknown" }));
    }),
  );
});
