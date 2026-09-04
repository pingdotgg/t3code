import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  UsageDay,
  USAGE_CONTRACT_VERSION,
  WS_METHODS,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerSettings,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("usage-environment"),
  label: "Usage environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const INPUT: UsageSummaryInput = {
  sinceDay: UsageDay.make("2026-09-01"),
  untilDay: UsageDay.make("2026-09-04"),
  timeZone: "UTC",
};

const CONFIG = {
  settings: DEFAULT_SERVER_SETTINGS,
  environment: { serverVersion: "0.0.1", capabilities: {} },
} as ServerConfig;

const makeHarness = Effect.fn("ServerUsageTest.makeHarness")(function* (
  beforeRead: (request: number) => Effect.Effect<void> = () => Effect.void,
) {
  const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
  let settings = DEFAULT_SERVER_SETTINGS;
  let requests = 0;
  const client = {
    [WS_METHODS.subscribeServerConfig]: () =>
      Stream.concat(
        Stream.make({ version: 1 as const, type: "snapshot" as const, config: CONFIG }),
        Stream.fromQueue(events),
      ),
    [WS_METHODS.serverGetUsageSummary]: (input: UsageSummaryInput) =>
      Effect.gen(function* () {
        requests += 1;
        const price = settings.usagePriceOverrides["custom-model"]?.inputCostPerMillionTokens ?? 0;
        yield* beforeRead(requests);
        return {
          contractVersion: USAGE_CONTRACT_VERSION,
          readAt: "2026-09-04T12:00:00Z",
          ...input,
          buckets: [
            {
              day: input.sinceDay,
              provider: "codex",
              model: "custom-model",
              totals: {
                uncachedInputTokens: 1_000_000,
                cachedInputTokens: 0,
                cacheCreationTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
              },
              costUsd: price,
              cacheSavingsUsd: 0,
              costSource: price === 0 ? "unpriced" : "modelPriced",
              records: 1,
              unpricedRecords: price === 0 ? 1 : 0,
              sessions: 1,
            },
          ],
          sources: [],
          pricing: { status: "unavailable", source: "test", fetchedAt: null, knownModels: 0 },
          scanDurationMs: 0,
        } satisfies UsageSummary;
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed(CONFIG),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environments = EnvironmentRegistry.of({
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"]);
  const cache = EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeed(Option.none()),
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry, environments),
      Layer.succeed(EnvironmentCacheStore, cache),
    ),
  );
  const initialConfigValueAtom = Atom.make(CONFIG);
  const atoms = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: () => initialConfigValueAtom,
  });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const updateSettings = Effect.fn("ServerUsageTest.updateSettings")(function* (
    next: ServerSettings,
  ) {
    settings = next;
    yield* Queue.offer(events, {
      version: 1,
      type: "settingsUpdated",
      payload: { settings },
    });
    yield* AtomRegistry.toStream(registry, atoms.settingsValueAtom(TARGET.environmentId)).pipe(
      Stream.filter((current) => current === next),
      Stream.runHead,
    );
  });
  return {
    registry,
    requests: () => requests,
    updateSettings,
    summary: (input = INPUT) => atoms.usageSummary({ environmentId: TARGET.environmentId, input }),
  };
});

function waitForCost<E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<UsageSummary, E>>,
  cost: number,
) {
  return AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter(
      (result) =>
        AsyncResult.isSuccess(result) &&
        !result.waiting &&
        result.value.buckets[0]?.costUsd === cost,
    ),
    Stream.runHead,
  );
}

it.effect("refreshes cached usage windows only when override prices change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const current = harness.summary();
      const previous = harness.summary({ ...INPUT, sinceDay: UsageDay.make("2026-08-01") });
      const unmountCurrent = harness.registry.mount(current);
      const unmountPrevious = harness.registry.mount(previous);
      yield* waitForCost(harness.registry, current, 0);
      yield* waitForCost(harness.registry, previous, 0);
      unmountPrevious();
      expect(harness.requests()).toBe(2);

      const prices = {
        "custom-model": { inputCostPerMillionTokens: 3, outputCostPerMillionTokens: 9 },
        "other-model": { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2 },
      };
      yield* harness.updateSettings({ ...DEFAULT_SERVER_SETTINGS, usagePriceOverrides: prices });
      yield* waitForCost(harness.registry, current, 3);
      yield* waitForCost(harness.registry, previous, 3);
      expect(harness.requests()).toBe(4);

      yield* harness.updateSettings({
        ...DEFAULT_SERVER_SETTINGS,
        usagePriceOverrides: {
          "other-model": { outputCostPerMillionTokens: 2, inputCostPerMillionTokens: 1 },
          "custom-model": { outputCostPerMillionTokens: 9, inputCostPerMillionTokens: 3 },
        },
      });
      yield* harness.updateSettings({
        ...DEFAULT_SERVER_SETTINGS,
        usagePriceOverrides: prices,
        defaultTheme: "custom-theme",
      });
      yield* harness.updateSettings(DEFAULT_SERVER_SETTINGS);
      yield* waitForCost(harness.registry, current, 0);
      yield* waitForCost(harness.registry, previous, 0);
      expect(harness.requests()).toBe(6);
      unmountCurrent();
    }),
  ),
);

it.effect("restarts a pending usage read after a price change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const harness = yield* makeHarness((request) =>
        request === 1
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            )
          : Effect.void,
      );
      const summary = harness.summary();
      const unmount = harness.registry.mount(summary);
      yield* Deferred.await(started);
      yield* harness.updateSettings({
        ...DEFAULT_SERVER_SETTINGS,
        usagePriceOverrides: {
          "custom-model": { inputCostPerMillionTokens: 5, outputCostPerMillionTokens: 10 },
        },
      });
      yield* waitForCost(harness.registry, summary, 5);
      yield* Deferred.await(interrupted);
      expect(harness.requests()).toBe(2);
      unmount();
    }),
  ),
);
