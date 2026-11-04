import { describe, expect, it } from "@effect/vitest";
import { Connectivity, Wakeups } from "@t3tools/client-runtime/connection";
import { setManagedRelaySession } from "@t3tools/client-runtime/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Network from "expo-network";
import { AppState, type AppStateStatus } from "react-native";
import { vi } from "vite-plus/test";

vi.mock("expo-network", () => ({
  getNetworkStateAsync: vi.fn(),
  addNetworkStateListener: vi.fn(),
  NetworkStateType: { WIFI: "WIFI", CELLULAR: "CELLULAR", UNKNOWN: "UNKNOWN", NONE: "NONE" },
}));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: vi.fn() },
}));
vi.mock("expo-device", () => ({}));
vi.mock("expo-constants", () => ({ default: {} }));
vi.mock("../lib/runtime", async () => ({ layer: (await import("effect/Layer")).empty }));
vi.mock("./storage", async () => ({ layer: (await import("effect/Layer")).empty }));
vi.mock("../persistence/mobile-storage", () => ({}));
vi.mock("../state/thread-outbox-removal", () => ({ clearThreadOutboxEnvironment: vi.fn() }));
vi.mock("../state/use-composer-drafts", () => ({ clearComposerDraftsEnvironment: vi.fn() }));
vi.mock("../state/thread-composer-error", () => ({
  clearThreadComposerErrorsForEnvironment: vi.fn(),
}));

import { appAtomRegistry } from "../state/atom-registry";
import { layerConnectivity, layerWakeups } from "./platform";

const wifi = { isConnected: true, type: Network.NetworkStateType.WIFI };
const cellular = { isConnected: true, type: Network.NetworkStateType.CELLULAR };
const offline = { isConnected: false, type: Network.NetworkStateType.NONE };
const unknown = { type: Network.NetworkStateType.UNKNOWN };

const setup = Effect.gen(function* () {
  const network = new Set<(state: Network.NetworkState) => void>();
  const application = new Set<(state: AppStateStatus) => void>();
  const registrations = yield* Queue.unbounded<void>();
  const reads = yield* Queue.unbounded<{
    resolve: (state: Network.NetworkState) => void;
    reject: () => void;
    settled: Effect.Effect<void>;
  }>();
  const removedNetwork: Array<(state: Network.NetworkState) => void> = [];
  const removedApplication: Array<(state: AppStateStatus) => void> = [];
  vi.mocked(Network.getNetworkStateAsync)
    .mockReset()
    .mockImplementation(() => {
      let resolve!: (state: Network.NetworkState) => void;
      let reject!: (cause: Error) => void;
      const promise = new Promise<Network.NetworkState>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      Queue.offerUnsafe(reads, {
        resolve,
        reject: () => reject(new Error("native read failed")),
        // Register after the production .then/.catch chain, so its callback has completed.
        settled: Effect.promise(() =>
          promise
            .then(
              () => undefined,
              () => undefined,
            )
            .then(() => undefined),
        ),
      });
      return promise;
    });
  vi.mocked(Network.addNetworkStateListener)
    .mockReset()
    .mockImplementation((callback) => {
      network.add(callback);
      Queue.offerUnsafe(registrations, undefined);
      return {
        remove: () => {
          network.delete(callback);
          removedNetwork.push(callback);
        },
      };
    });
  vi.mocked(AppState.addEventListener)
    .mockReset()
    .mockImplementation((_, callback) => {
      application.add(callback);
      return {
        remove: () => {
          application.delete(callback);
          removedApplication.push(callback);
        },
      };
    });
  AppState.currentState = "active";
  setManagedRelaySession(appAtomRegistry, null);
  return {
    reads,
    registrations,
    removedNetwork,
    removedApplication,
    network: (state: Network.NetworkState) => {
      for (const callback of network) callback(state);
    },
    app: (state: AppStateStatus) => {
      AppState.currentState = state;
      for (const callback of application) callback(state);
    },
    counts: () => ({
      network: network.size,
      application: application.size,
      reads: vi.mocked(Network.getNetworkStateAsync).mock.calls.length,
    }),
  };
});

const services = Effect.gen(function* () {
  const context = yield* Layer.build(Layer.merge(layerConnectivity, layerWakeups));
  return {
    connectivity: Context.get(context, Connectivity.Connectivity),
    wakeups: Context.get(context, Wakeups.ConnectionWakeups),
  };
});

const consume = <A>(stream: Stream.Stream<A>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const pull = yield* Stream.toPull(stream.pipe(Stream.rechunk(1))).pipe(Scope.provide(scope));
    const first = yield* Effect.forkIn(pull, scope, { startImmediately: true });
    let initial = true;
    const next = Effect.suspend(() => {
      if (!initial) return pull;
      initial = false;
      return Fiber.join(first);
    }).pipe(Effect.map((chunk) => chunk[0]));
    return { next, close: Scope.close(scope, Exit.void) };
  });

const seed = (native: Effect.Success<typeof setup>, state = wifi) =>
  Effect.gen(function* () {
    const read = yield* Queue.take(native.reads);
    read.resolve(state);
    yield* read.settled;
  });

describe("mobile connection signals", () => {
  it.effect("shares acquisition for eleven status readers and ten wakeup readers", () =>
    Effect.gen(function* () {
      const native = yield* setup;
      const { connectivity, wakeups } = yield* services;
      const statuses = yield* Effect.forEach(Array.from({ length: 11 }), () =>
        consume(connectivity.changes),
      );
      const events = yield* Effect.forEach(Array.from({ length: 10 }), () =>
        consume(wakeups.changes),
      );
      yield* seed(native);
      expect(native.counts()).toEqual({ network: 2, application: 11, reads: 1 });
      native.network(offline);
      for (const reader of statuses) expect(yield* reader.next).toBe("offline");
      native.app("active");
      yield* seed(native, offline);
      for (const reader of statuses) expect(yield* reader.next).toBe("offline");
      for (const reader of events) expect(yield* reader.next).toBe("application-active-probe");
      expect(native.counts().reads).toBe(2);
      native.network(cellular);
      for (const reader of statuses) expect(yield* reader.next).toBe("online");
      for (const reader of events) expect(yield* reader.next).toBe("network-changed");
      for (const reader of statuses.slice(1)) yield* reader.close;
      for (const reader of events.slice(1)) yield* reader.close;
      expect(native.counts().network).toBe(2);
      native.network(wifi);
      expect(yield* statuses[0]!.next).toBe("online");
      expect(yield* events[0]!.next).toBe("network-changed");
      yield* statuses[0]!.close;
      yield* events[0]!.close;
      expect(native.counts()).toEqual({ network: 0, application: 0, reads: 2 });
    }),
  );

  it.effect("gives late environments fresh status without replaying status or wakeups", () =>
    Effect.gen(function* () {
      const native = yield* setup;
      const { connectivity, wakeups } = yield* services;
      const first = yield* consume(connectivity.changes);
      const firstWake = yield* consume(wakeups.changes);
      yield* seed(native);
      native.network(wifi);
      expect(yield* first.next).toBe("online");
      native.app("active");
      yield* seed(native, wifi);
      expect(yield* first.next).toBe("online");
      expect(yield* firstWake.next).toBe("application-active-probe");
      native.network(offline);
      expect(yield* first.next).toBe("offline");
      const late = yield* consume(connectivity.changes);
      const lateWake = yield* consume(wakeups.changes);
      const status = yield* Effect.forkScoped(connectivity.status, { startImmediately: true });
      yield* seed(native, offline);
      expect(yield* Fiber.join(status)).toBe("offline");
      native.network(unknown);
      expect(yield* first.next).toBe("unknown");
      expect(yield* late.next).toBe("unknown");
      setManagedRelaySession(appAtomRegistry, {
        accountId: "account-a",
        readClerkToken: () => Promise.resolve("test-token"),
      });
      expect(yield* firstWake.next).toBe("credentials-changed");
      expect(yield* lateWake.next).toBe("credentials-changed");
    }),
  );

  it.effect(
    "preserves path ordering when the seed finishes late, including offline and unknown states",
    () =>
      Effect.gen(function* () {
        const native = yield* setup;
        const { connectivity, wakeups } = yield* services;
        const status = yield* consume(connectivity.changes);
        const event = yield* consume(wakeups.changes);
        const pending = yield* Queue.take(native.reads);
        native.network(cellular);
        expect(yield* status.next).toBe("online");
        pending.resolve(wifi);
        yield* pending.settled;
        native.network(offline);
        expect(yield* status.next).toBe("offline");
        native.network(unknown);
        expect(yield* status.next).toBe("unknown");
        native.network(cellular);
        expect(yield* status.next).toBe("online");
        native.network(wifi);
        expect(yield* status.next).toBe("online");
        expect(yield* event.next).toBe("network-changed");
        // A different event exposes any extra wakeup queued by an obsolete seed.
        native.app("active");
        expect(yield* event.next).toBe("application-active-probe");
      }),
  );

  it.effect("distinguishes short and long resumes and fans out account changes", () =>
    Effect.gen(function* () {
      const native = yield* setup;
      const { wakeups } = yield* services;
      const first = yield* consume(wakeups.changes);
      const second = yield* consume(wakeups.changes);
      yield* seed(native);
      using now = vi.spyOn(Date, "now").mockReturnValue(100_000);
      native.app("background");
      now.mockReturnValue(105_000);
      native.app("active");
      expect(yield* first.next).toBe("application-active-probe");
      expect(yield* second.next).toBe("application-active-probe");
      native.app("background");
      now.mockReturnValue(115_000);
      native.app("active");
      expect(yield* first.next).toBe("application-active-long");
      expect(yield* second.next).toBe("application-active-long");
      for (const accountId of ["account-a", "account-b"]) {
        setManagedRelaySession(appAtomRegistry, {
          accountId,
          readClerkToken: () => Promise.resolve("test-token"),
        });
        expect(yield* first.next).toBe("credentials-changed");
        expect(yield* second.next).toBe("credentials-changed");
      }
    }),
  );

  it.effect("keeps resume age local to readers joining during background or inactive", () =>
    Effect.forEach(["background", "inactive"] as const, (joiningState) =>
      Effect.scoped(
        Effect.gen(function* () {
          const native = yield* setup;
          const { wakeups } = yield* services;
          using now = vi.spyOn(Date, "now").mockReturnValue(100_000);
          const early = yield* consume(wakeups.changes);
          yield* seed(native);
          native.app("background");
          now.mockReturnValue(112_000);
          if (joiningState === "inactive") native.app("inactive");
          const late = yield* consume(wakeups.changes);
          setManagedRelaySession(appAtomRegistry, {
            accountId: joiningState,
            readClerkToken: () => Promise.resolve("test-token"),
          });
          // Confirm the late reader is subscribed before the native resume arrives.
          expect(yield* early.next).toBe("credentials-changed");
          expect(yield* late.next).toBe("credentials-changed");
          now.mockReturnValue(113_000);
          native.app("active");
          expect(yield* early.next).toBe("application-active-long");
          expect(yield* late.next).toBe("application-active-probe");
        }),
      ),
    ),
  );

  it.effect(
    "releases native work, ignores old callbacks and pending reads, and reacquires cleanly",
    () =>
      Effect.gen(function* () {
        const native = yield* setup;
        const { connectivity, wakeups } = yield* services;
        const first = yield* consume(connectivity.changes);
        const firstWake = yield* consume(wakeups.changes);
        const pendingSeed = yield* Queue.take(native.reads);
        native.app("active");
        const pendingResume = yield* Queue.take(native.reads);
        expect(yield* firstWake.next).toBe("application-active-probe");
        yield* first.close;
        yield* firstWake.close;
        expect(native.counts().network).toBe(0);
        const next = yield* consume(connectivity.changes);
        const nextWake = yield* consume(wakeups.changes);
        yield* seed(native, cellular);
        pendingSeed.resolve(wifi);
        pendingResume.resolve(offline);
        yield* pendingSeed.settled;
        yield* pendingResume.settled;
        for (const callback of native.removedNetwork) callback(offline);
        for (const callback of native.removedApplication) callback("active");
        native.network(wifi);
        expect(yield* next.next).toBe("online");
        expect(yield* nextWake.next).toBe("network-changed");
        expect(native.counts()).toEqual({ network: 2, application: 2, reads: 3 });
      }),
  );

  it.effect("preserves native callback order during acquisition", () =>
    Effect.gen(function* () {
      const native = yield* setup;
      const register = vi.mocked(Network.addNetworkStateListener).getMockImplementation()!;
      vi.mocked(Network.addNetworkStateListener).mockImplementation((callback) => {
        const subscription = register(callback);
        callback(wifi);
        callback(offline);
        return subscription;
      });
      const { connectivity } = yield* services;
      const first = yield* consume(connectivity.changes);
      expect(yield* first.next).toBe("online");
      expect(yield* first.next).toBe("offline");
      const late = yield* consume(connectivity.changes);
      native.network(unknown);
      expect(yield* first.next).toBe("unknown");
      expect(yield* late.next).toBe("unknown");
    }),
  );

  it.effect("keeps native read failures local and status uncached", () =>
    Effect.gen(function* () {
      const native = yield* setup;
      const { connectivity, wakeups } = yield* services;
      const status = yield* consume(connectivity.changes);
      const wake = yield* consume(wakeups.changes);
      const pathSeed = yield* Queue.take(native.reads);
      pathSeed.reject();
      yield* pathSeed.settled;
      native.network(wifi);
      expect(yield* status.next).toBe("online");
      native.app("active");
      const resume = yield* Queue.take(native.reads);
      resume.reject();
      yield* resume.settled;
      expect(yield* wake.next).toBe("application-active-probe");
      const failedStatus = yield* Effect.forkScoped(connectivity.status, {
        startImmediately: true,
      });
      const failedRead = yield* Queue.take(native.reads);
      failedRead.reject();
      expect(yield* Fiber.join(failedStatus)).toBe("unknown");
      const freshStatus = yield* Effect.forkScoped(connectivity.status, { startImmediately: true });
      yield* seed(native, offline);
      expect(yield* Fiber.join(freshStatus)).toBe("offline");
      native.network(cellular);
      expect(yield* status.next).toBe("online");
      expect(yield* wake.next).toBe("network-changed");
    }),
  );

  it.effect("keeps wakeups for a slow reader without delaying a fast reader", () =>
    Effect.gen(function* () {
      const native = yield* setup;
      const { wakeups } = yield* services;
      const slow = yield* consume(wakeups.changes);
      const fast = yield* consume(wakeups.changes);
      yield* seed(native);
      for (let i = 0; i < 100; i++) native.network(i % 2 === 0 ? cellular : wifi);
      for (let i = 0; i < 100; i++) expect(yield* fast.next).toBe("network-changed");
      for (let i = 0; i < 100; i++) expect(yield* slow.next).toBe("network-changed");
      native.app("active");
      expect(yield* fast.next).toBe("application-active-probe");
      expect(yield* slow.next).toBe("application-active-probe");
    }),
  );

  it.effect(
    "keeps all ordered events for a slow reader when another reader exits with an error",
    () =>
      Effect.gen(function* () {
        const native = yield* setup;
        const { connectivity } = yield* services;
        const slow = yield* consume(connectivity.changes);
        const failed = yield* consume(connectivity.changes);
        yield* Queue.take(native.registrations);
        const failure = yield* Effect.forkScoped(
          failed.next.pipe(
            Effect.andThen(Effect.fail("consumer failed")),
            Effect.ensuring(failed.close),
            Effect.exit,
          ),
          { startImmediately: true },
        );
        yield* Effect.sync(() => {
          for (let i = 0; i < 100; i++) native.network(i % 2 === 0 ? offline : wifi);
        });
        expect(Exit.isFailure(yield* Fiber.join(failure))).toBe(true);
        for (let i = 0; i < 100; i++)
          expect(yield* slow.next).toBe(i % 2 === 0 ? "offline" : "online");
        expect(native.counts().network).toBe(1);
        native.network(unknown);
        expect(yield* slow.next).toBe("unknown");
        yield* slow.close;
        expect(native.counts().network).toBe(0);
      }),
  );
});
