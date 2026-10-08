import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  UsageDay,
  UsageReadError,
  USAGE_CONTRACT_VERSION,
  WS_METHODS,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerSettings,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { EnvironmentPresentation } from "../connection/presentation.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";
import { refreshUsage } from "./usage.ts";

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

const PRICING = { status: "unavailable" as const, source: "test", fetchedAt: null, knownModels: 0 };

const cursorSource = (refreshing: boolean): UsageSource => ({
  fingerprint: {
    hostId: "cursor.com",
    provider: "cursor",
    resolvedHomePath: "cursor-account:abc",
    volumeId: "abc",
  },
  status: "ok",
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 1,
  message: null,
  ...(refreshing ? { refreshing: true as const } : {}),
});

const makeHarness = Effect.fn("ServerUsageTest.makeHarness")(function* (
  beforeRead: (
    request: number,
    input: UsageSummaryInput,
  ) => Effect.Effect<void, UsageReadError> = () => Effect.void,
  sources: (input: UsageSummaryInput) => readonly UsageSource[] = () => [],
) {
  const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
  let settings = DEFAULT_SERVER_SETTINGS;
  let requests = 0;
  const inputs: UsageSummaryInput[] = [];
  const client = {
    [WS_METHODS.serverRefreshUsageRates]: () => Effect.succeed(PRICING),
    [WS_METHODS.subscribeServerConfig]: () =>
      Stream.concat(
        Stream.make({ version: 1 as const, type: "snapshot" as const, config: CONFIG }),
        Stream.fromQueue(events),
      ),
    [WS_METHODS.serverGetUsageSummary]: (input: UsageSummaryInput) =>
      Effect.gen(function* () {
        requests += 1;
        inputs.push(input);
        const price = settings.usagePriceOverrides["custom-model"]?.inputCostPerMillionTokens ?? 0;
        yield* beforeRead(requests, input);
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
          sources: sources(input),
          pricing: PRICING,
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
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
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
  const environments = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
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
  });
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
      Layer.succeed(Persistence.EnvironmentCacheStore, cache),
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
    atoms,
    requests: () => requests,
    inputs: () => inputs,
    updateSettings,
    summary: (input = INPUT) => atoms.usageSummary({ environmentId: TARGET.environmentId, input }),
  };
});

function settledSummary<E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<UsageSummary, E>>,
) {
  return AtomRegistry.toStream(registry, atom).pipe(
    Stream.filterMap((result) =>
      AsyncResult.isSuccess(result) && !result.waiting
        ? Result.succeed(result.value)
        : Result.failVoid,
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

/** Answers with a refreshing Cursor source; the `awaitRefresh` request runs `followUp` first. */
const makeRefreshingHarness = Effect.fn("ServerUsageTest.makeRefreshingHarness")(function* (
  followUp: Effect.Effect<void, UsageReadError>,
) {
  const followUpStarted = yield* Deferred.make<void>();
  const harness = yield* makeHarness(
    (_request, input) =>
      input.awaitRefresh === true
        ? Deferred.succeed(followUpStarted, undefined).pipe(Effect.andThen(followUp))
        : Effect.void,
    (input) => [cursorSource(input.awaitRefresh !== true)],
  );
  return { ...harness, followUpStarted };
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

it.effect("settles after one usage read when no source is refreshing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const summary = harness.summary();
      const unmount = harness.registry.mount(summary);
      yield* settledSummary(harness.registry, summary);
      expect(harness.inputs()).toEqual([INPUT]);
      unmount();
    }),
  ),
);

it.effect("shows the cached usage summary until one awaited refresh replaces it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const refreshed = yield* Deferred.make<void>();
      const harness = yield* makeRefreshingHarness(Deferred.await(refreshed));
      const summary = harness.summary();
      const unmount = harness.registry.mount(summary);
      yield* Deferred.await(harness.followUpStarted);

      const provisional = harness.registry.get(summary);
      expect(AsyncResult.isSuccess(provisional) && provisional.waiting).toBe(true);
      expect(Option.getOrNull(AsyncResult.value(provisional))?.sources).toEqual([
        cursorSource(true),
      ]);
      expect(harness.inputs()).toEqual([INPUT, { ...INPUT, awaitRefresh: true }]);

      yield* Deferred.succeed(refreshed, undefined);
      expect((yield* settledSummary(harness.registry, summary)).sources).toEqual([
        cursorSource(false),
      ]);
      expect(harness.requests()).toBe(2);
      unmount();
    }),
  ),
);

it.effect("keeps the cached usage summary when the awaited refresh fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeRefreshingHarness(
        Effect.fail(new UsageReadError({ reason: "scanFailed", detail: "Cursor is down" })),
      );
      const summary = harness.summary();
      const unmount = harness.registry.mount(summary);
      expect((yield* settledSummary(harness.registry, summary)).sources).toEqual([
        cursorSource(true),
      ]);
      expect(AsyncResult.isSuccess(harness.registry.get(summary))).toBe(true);
      expect(harness.requests()).toBe(2);
      unmount();
    }),
  ),
);

it.effect("finishes a manual usage refresh only after the awaited refresh", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const refreshed = yield* Deferred.make<void>();
      const harness = yield* makeRefreshingHarness(Deferred.await(refreshed));
      const presentation = Atom.make({
        connection: { phase: "connected" },
      } as EnvironmentPresentation | null);
      let finished = false;
      const refreshing = refreshUsage({
        registry: harness.registry,
        server: harness.atoms,
        presentations: { presentationAtom: () => presentation },
        environmentIds: [TARGET.environmentId],
        input: INPUT,
      }).then(() => {
        finished = true;
      });
      yield* Deferred.await(harness.followUpStarted);
      expect(finished).toBe(false);
      yield* Deferred.succeed(refreshed, undefined);
      yield* Effect.promise(() => refreshing);
      expect(harness.requests()).toBe(2);
    }),
  ),
);
