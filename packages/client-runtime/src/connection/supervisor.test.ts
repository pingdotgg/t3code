import { type ServerConfig } from "@t3tools/contracts";
import {
  describe,
  expect,
  it,
} from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import { BearerConnectionProfile } from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  RelayConnectionTarget,
} from "./model.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import {
  connectionRouteId,
  entryWithRoutes,
  isLearned,
  mergeLearnedRoutes,
} from "./routes.ts";
import {
  LAN_ROUTE,
  LAN_TARGET,
  LAN_THEN_RELAY_ENTRY,
  RELAY_TARGET,
  TARGET,
  awaitState,
  blocked,
  makeHarness,
  preparedFor,
  transient,
} from "./supervisor.helpers2.testkit.ts";

describe("EnvironmentSupervisor routes", () => {
  it.effect("connects over relay before a slow LAN reachability check times out", () =>
    Effect.gen(function* () {
      const checkingLan = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Deferred.succeed(checkingLan, undefined).pipe(
                Effect.andThen(Effect.sleep("2500 millis")),
                Effect.as("silent" as const),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(checkingLan);
      yield* TestClock.adjust("500 millis");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "RelayConnectionTarget",
      );
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("shares one head start across several slow LAN routes", () =>
    Effect.gen(function* () {
      const secondLanTarget = new BearerConnectionTarget({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        connectionId: "bearer:second-lan",
      });
      const entry: ConnectionCatalogEntry = {
        ...LAN_THEN_RELAY_ENTRY,
        alternateRoutes: [
          {
            target: secondLanTarget,
            profile: Option.some(
              new BearerConnectionProfile({
                connectionId: secondLanTarget.connectionId,
                environmentId: TARGET.environmentId,
                label: TARGET.label,
                httpBaseUrl: "http://192.168.56.1:3773/",
                wsBaseUrl: "ws://192.168.56.1:3773/",
              }),
            ),
          },
          { target: RELAY_TARGET, profile: Option.none() },
        ],
      };
      const checking = yield* Ref.make(0);
      const checkingLans = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.updateAndGet(checking, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 2 ? Deferred.succeed(checkingLans, undefined) : Effect.void,
                ),
                Effect.andThen(Effect.sleep("2500 millis")),
                Effect.as("silent" as const),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(entry, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(checkingLans);
      yield* TestClock.adjust("500 millis");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "RelayConnectionTarget",
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("still prefers a LAN route that responds within its head start", () =>
    Effect.gen(function* () {
      const checkingLan = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Deferred.succeed(checkingLan, undefined).pipe(
                Effect.andThen(Effect.sleep("100 millis")),
                Effect.as("answered" as const),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(checkingLan);
      yield* TestClock.adjust("100 millis");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("tries a slow tailnet route that answered before a dead LAN route", () =>
    Effect.gen(function* () {
      const tailnetTarget = new BearerConnectionTarget({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        connectionId: "bearer:tailnet",
      });
      // No relay: a Tailscale-only client away from the LAN.
      const entry: ConnectionCatalogEntry = {
        ...LAN_THEN_RELAY_ENTRY,
        alternateRoutes: [
          {
            target: tailnetTarget,
            profile: Option.some(
              new BearerConnectionProfile({
                connectionId: tailnetTarget.connectionId,
                environmentId: TARGET.environmentId,
                label: TARGET.label,
                httpBaseUrl: "http://100.100.1.2:3773/",
                wsBaseUrl: "ws://100.100.1.2:3773/",
                network: "tailscale",
              }),
            ),
          },
        ],
      };
      const checking = yield* Ref.make(0);
      const checkingBoth = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          Ref.updateAndGet(checking, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === 2 ? Deferred.succeed(checkingBoth, undefined) : Effect.void,
            ),
            Effect.andThen(
              connectionRouteId(route.target) === LAN_TARGET.connectionId
                ? Effect.sleep("2500 millis").pipe(Effect.as("silent" as const))
                : Effect.sleep("700 millis").pipe(Effect.as("answered" as const)),
            ),
          ),
        // The dead LAN address never answers the connection itself either.
        prepare: (_attempt, target) =>
          target._tag === "BearerConnectionTarget" &&
          target.connectionId === LAN_TARGET.connectionId
            ? Effect.never
            : Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(entry, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(checkingBoth);
      yield* TestClock.adjust("2500 millis");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(
        connectionRouteId(
          Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target,
        ),
      ).toBe("bearer:tailnet");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("still tries a slow LAN route when relay fails", () =>
    Effect.gen(function* () {
      const checkingLan = yield* Deferred.make<void>();
      const attempted: string[] = [];
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Deferred.succeed(checkingLan, undefined).pipe(
                Effect.andThen(Effect.sleep("2500 millis")),
                Effect.as("answered" as const),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => {
          attempted.push(target._tag);
          return target._tag === "RelayConnectionTarget"
            ? Effect.fail(blocked("Sign in to T3 Connect."))
            : Effect.succeed(preparedFor(target));
        },
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(checkingLan);
      yield* TestClock.adjust("2500 millis");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(attempted).toEqual(["RelayConnectionTarget", "BearerConnectionTarget"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("skips a silent LAN route and connects over T3 Connect", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          Effect.succeed(route.target._tag === "BearerConnectionTarget" ? "silent" : "unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.target._tag).toBe("RelayConnectionTarget");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );

  it.effect("moves to a blocked route's fallback instead of stopping", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("answered"),
        prepare: (_attempt, target) =>
          target._tag === "BearerConnectionTarget"
            ? Effect.fail(blocked("The environment credential is invalid."))
            : Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.target._tag).toBe("RelayConnectionTarget");
    }),
  );

  it.effect("tries every route when none answers the reachability check", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("silent"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.target._tag).toBe("BearerConnectionTarget");
    }),
  );

  it.effect("keeps retrying when one route is blocked and another failed transiently", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("answered"),
        prepare: (_attempt, target) =>
          target._tag === "RelayConnectionTarget"
            ? Effect.fail(blocked("Sign in to T3 Connect."))
            : Effect.fail(transient("LAN socket refused.")),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      const state = yield* awaitState(supervisor.state, (value) => value.phase === "backoff");
      expect(state.lastFailure?._tag).toBe("ConnectionTransientError");
    }),
  );

  it.effect("moves back to the LAN route when the network changes and it answers again", () =>
    Effect.gen(function* () {
      const lanReachable = yield* Ref.make(false);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.get(lanReachable).pipe(
                Effect.map((reachable) => (reachable ? "answered" : "silent")),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "RelayConnectionTarget",
      );

      yield* Ref.set(lanReachable, true);
      yield* harness.setNetworkStatus("unknown");
      yield* harness.setNetworkStatus("online");

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("checks a dead LAN route less often until the network changes", () =>
    Effect.gen(function* () {
      const lanReachable = yield* Ref.make(false);
      const lanChecks = yield* Ref.make(0);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.update(lanChecks, (count) => count + 1).pipe(
                Effect.andThen(Ref.get(lanReachable)),
                Effect.map((reachable) => (reachable ? "answered" : "silent")),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* Ref.set(lanChecks, 0);

      // Checked at 1, 3 and 7 minutes instead of every minute.
      for (let minute = 0; minute < 10; minute += 1) {
        yield* TestClock.adjust("60 seconds");
      }
      expect(yield* Ref.get(lanChecks)).toBe(3);

      yield* Ref.set(lanReachable, true);
      yield* harness.wake("network-changed");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
    }),
  );

  it.effect("keeps checking a LAN route every minute when it answers but cannot be prepared", () =>
    Effect.gen(function* () {
      const lanPreflights = yield* Ref.make(0);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          Effect.succeed(route.target._tag === "BearerConnectionTarget" ? "silent" : "unchecked"),
        preflight: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.update(lanPreflights, (count) => count + 1).pipe(Effect.as("unprepared" as const))
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      for (let minute = 0; minute < 10; minute += 1) {
        yield* TestClock.adjust("60 seconds");
      }
      expect(yield* Ref.get(lanPreflights)).toBe(10);
    }),
  );

  it.effect("ignores a dead LAN check that was running when the network changed", () =>
    Effect.gen(function* () {
      const lanChecks = yield* Ref.make(0);
      const checkStarted = yield* Deferred.make<void>();
      const finishCheck = yield* Deferred.make<void>();
      const woke = yield* Ref.make(false);
      const wakeupHandled = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.updateAndGet(lanChecks, (count) => count + 1).pipe(
                Effect.flatMap((check) =>
                  check === 1
                    ? Effect.succeed("silent" as const)
                    : check === 2
                      ? Deferred.succeed(checkStarted, undefined).pipe(
                          Effect.andThen(Deferred.await(finishCheck)),
                          Effect.as("silent" as const),
                        )
                      : Effect.succeed("answered" as const),
                ),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        // The wakeup probes the session only after it forgets the silent routes.
        probe: () =>
          Ref.get(woke).pipe(
            Effect.flatMap((afterWake) =>
              afterWake ? Deferred.succeed(wakeupHandled, undefined) : Effect.void,
            ),
            Effect.asVoid,
          ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* TestClock.adjust("60 seconds");
      yield* Deferred.await(checkStarted);
      yield* Ref.set(woke, true);
      yield* harness.wake("network-changed");
      yield* Deferred.await(wakeupHandled);
      yield* Deferred.succeed(finishCheck, undefined);

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
    }),
  );

  it.effect("moves off a dead LAN socket when the phone switches to cellular", () =>
    Effect.gen(function* () {
      const lanReachable = yield* Ref.make(true);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.get(lanReachable).pipe(
                Effect.map((reachable) => (reachable ? "answered" : "silent")),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        probe: () =>
          Ref.get(lanReachable).pipe(
            Effect.flatMap((reachable) => (reachable ? Effect.void : Effect.never)),
          ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );

      yield* Ref.set(lanReachable, false);
      yield* harness.wake("network-changed");
      yield* TestClock.adjust("3 seconds");

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "RelayConnectionTarget",
      );
    }),
  );

  it.effect.each(["initial", "late", "withdrawn", "withdrawn-upgrade", "omitted"] as const)(
    "learns the %s direct endpoint over T3 Connect",
    (discovery) =>
      Effect.gen(function* () {
        const relayEntry: ConnectionCatalogEntry =
          discovery.startsWith("withdrawn") || discovery === "omitted"
            ? {
                target: LAN_ROUTE.target,
                profile: Option.some(
                  new BearerConnectionProfile({
                    ...Option.getOrThrow(LAN_ROUTE.profile),
                    ...(discovery === "withdrawn-upgrade"
                      ? {
                          httpBaseUrl: "https://old.example.test/",
                          wsBaseUrl: "wss://old.example.test/",
                        }
                      : {}),
                    learned: true,
                    authorization: "t3-connect",
                  }),
                ),
                alternateRoutes: [{ target: RELAY_TARGET, profile: Option.none() }],
                enabled: true,
              }
            : {
                target: RELAY_TARGET,
                profile: Option.none(),
                enabled: true,
              };
        const initialProcessed = yield* Deferred.make<void>();
        const discoveryProcessed = yield* Deferred.make<void>();
        const discoveryStarted = yield* Deferred.make<void>();
        const finishDiscovery = yield* Deferred.make<void>();
        const lateAddress = "https://fixture.tail1234.ts.net/";
        const learned = yield* Ref.make<ReadonlyArray<string>>([]);
        const harness = yield* makeHarness({
          configEvents:
            discovery !== "initial"
              ? Stream.concat(
                  Stream.make({
                    version: 1 as const,
                    type: "snapshot" as const,
                    config: (discovery === "omitted"
                      ? {}
                      : { directEndpoints: [] }) as unknown as ServerConfig,
                  }).pipe(Stream.ensuring(Deferred.succeed(initialProcessed, undefined))),
                  Stream.fromEffect(
                    Deferred.await(finishDiscovery).pipe(
                      Effect.as({
                        version: 1 as const,
                        type: "snapshot" as const,
                        config: {
                          directEndpoints: [{ kind: "tailnet", httpBaseUrl: lateAddress }],
                        } as unknown as ServerConfig,
                      }),
                    ),
                  ),
                ).pipe(Stream.ensuring(Deferred.succeed(discoveryProcessed, undefined)))
              : undefined,
          checkRoute: (route) =>
            route.target._tag === "BearerConnectionTarget"
              ? Effect.succeed("answered")
              : Effect.succeed("unchecked"),
          prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
          initialConfig: () =>
            Effect.succeed({
              directEndpoints:
                discovery !== "initial"
                  ? []
                  : [{ kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" }],
            } as unknown as ServerConfig),
        });
        const current = yield* Ref.make(relayEntry);
        const supervisor = yield* EnvironmentSupervisor.make(relayEntry, {
          initiallyDesired: true,
          learnRoutes: ({ activeRoute, reported }) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(discoveryStarted, undefined);
              const entry = yield* Ref.get(current);
              const routes = mergeLearnedRoutes({
                entry,
                activeRoute,
                reported,
                allowInsecure: true,
              });
              if (routes === null) return Option.none();
              const next = entryWithRoutes(entry, routes);
              yield* Ref.set(current, next);
              yield* Ref.update(learned, (all) => [
                ...all,
                ...routes.filter(isLearned).map((route) => connectionRouteId(route.target)),
              ]);
              return Option.some(next);
            }),
        }).pipe(Effect.provide(harness.dependencies));

        if (discovery === "omitted") {
          yield* Deferred.await(initialProcessed);
          expect(yield* Ref.get(current)).toEqual(relayEntry);
          expect(yield* Ref.get(learned)).toEqual([]);
        } else {
          yield* Deferred.await(discoveryStarted);
        }
        yield* Deferred.succeed(finishDiscovery, undefined);
        if (discovery === "withdrawn-upgrade") {
          yield* Deferred.await(discoveryProcessed);
          yield* TestClock.adjust("60 seconds");
          expect((yield* SubscriptionRef.get(supervisor.state)).generation).toBe(2);
          return;
        }
        if (discovery === "withdrawn" || discovery === "omitted") {
          yield* Deferred.await(discoveryProcessed);
          expect(yield* Ref.get(learned)).toContain(
            `learned:${TARGET.environmentId}:https://fixture.tail1234.ts.net`,
          );
          expect((yield* SubscriptionRef.get(supervisor.state)).generation).toBe(1);
          return;
        }
        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 2,
        );
        expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
          "BearerConnectionTarget",
        );
        expect(yield* Ref.get(learned)).toEqual([
          `learned:${TARGET.environmentId}:${discovery !== "initial" ? "https://fixture.tail1234.ts.net" : "http://192.168.1.10:3773"}`,
        ]);
      }),
  );
});
