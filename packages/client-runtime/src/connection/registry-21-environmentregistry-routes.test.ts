import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  BearerConnectionProfile,
  BearerConnectionRegistration,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "./catalog.ts";
import { connectionRouteKind } from "./routes.ts";
import {
  ConnectionBlockedError,
  BearerConnectionTarget,
  SshConnectionTarget,
  type SupervisorConnectionState,
} from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import {
  PullRequestRoutingPermissions,
  type StoredPullRequestRoutingPermission,
  makePullRequestRoutingPermissions,
} from "./pullRequestRoutingPermissions.ts";
import {
  BEARER_CREDENTIAL,
  BEARER_PROFILE,
  BEARER_TARGET,
  RELAY_TARGET,
  SECOND_RELAY_TARGET,
  SSH_CONNECTION,
  SSH_PROFILE,
} from "./registry-21-environmentregistry-routes.part2.testkit.ts";
import {
  hasRoutes,
  makeHarness,
  routesOf,
} from "./registry-21-environmentregistry-routes.part3.testkit.ts";

function awaitConnectionState(
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  environmentId: EnvironmentId,
  predicate: (state: SupervisorConnectionState) => boolean,
) {
  return Effect.gen(function* () {
    const current = yield* registry.state(environmentId);
    if (predicate(current)) {
      return current;
    }
    return yield* registry
      .stateChanges(environmentId)
      .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
  });
}

describe("EnvironmentRegistry routes", () => {
  const LAN_TARGET = new BearerConnectionTarget({
    environmentId: RELAY_TARGET.environmentId,
    label: RELAY_TARGET.label,
    connectionId: "bearer:lan",
  });
  const LAN_PROFILE = new BearerConnectionProfile({
    connectionId: LAN_TARGET.connectionId,
    environmentId: LAN_TARGET.environmentId,
    label: LAN_TARGET.label,
    httpBaseUrl: "http://192.168.1.10:3773/",
    wsBaseUrl: "ws://192.168.1.10:3773/",
  });
  const lanRegistration = (target = LAN_TARGET, profile = LAN_PROFILE) =>
    new BearerConnectionRegistration({ target, profile, credential: BEARER_CREDENTIAL });

  it.effect("adds a paired LAN route ahead of T3 Connect instead of replacing it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([RELAY_TARGET]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.register(lanRegistration());

        expect(routesOf(yield* Ref.get(harness.storedTargets), LAN_TARGET.environmentId)).toEqual([
          LAN_TARGET,
          RELAY_TARGET,
        ]);
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(LAN_TARGET.environmentId);
        expect(entry?.target).toEqual(LAN_TARGET);
        expect(entry?.alternateRoutes?.map((route) => route.target)).toEqual([RELAY_TARGET]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("re-pairing the same address replaces that route rather than adding another", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [LAN_TARGET, RELAY_TARGET],
        [LAN_PROFILE],
        [[LAN_TARGET.connectionId, BEARER_CREDENTIAL]],
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const repaired = new BearerConnectionTarget({
          ...LAN_TARGET,
          connectionId: "bearer:lan-again",
        });
        yield* registry.register(
          lanRegistration(
            repaired,
            new BearerConnectionProfile({ ...LAN_PROFILE, connectionId: repaired.connectionId }),
          ),
        );

        expect(routesOf(yield* Ref.get(harness.storedTargets), LAN_TARGET.environmentId)).toEqual([
          repaired,
          RELAY_TARGET,
        ]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("re-pairing at another loopback address prefers the new route", () =>
    Effect.gen(function* () {
      const loopback = (connectionId: string, host: string) =>
        [
          new BearerConnectionTarget({ ...LAN_TARGET, connectionId }),
          new BearerConnectionProfile({
            ...LAN_PROFILE,
            connectionId,
            httpBaseUrl: `http://${host}:3773/`,
            wsBaseUrl: `ws://${host}:3773/`,
          }),
        ] as const;
      const [savedTarget, savedProfile] = loopback("bearer:ip", "127.0.0.1");
      const [pastedTarget, pastedProfile] = loopback("bearer:localhost", "localhost");
      const harness = yield* makeHarness(
        [savedTarget, RELAY_TARGET],
        [savedProfile],
        [[savedTarget.connectionId, BEARER_CREDENTIAL]],
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.register(lanRegistration(pastedTarget, pastedProfile));

        expect(routesOf(yield* Ref.get(harness.storedTargets), LAN_TARGET.environmentId)).toEqual([
          pastedTarget,
          savedTarget,
          RELAY_TARGET,
        ]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect(
    "adding a saved SSH host again replaces its route, whatever id it was saved under",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness([SSH_CONNECTION], [SSH_PROFILE]);
        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          const again = new SshConnectionTarget({
            ...SSH_CONNECTION,
            connectionId: "ssh-connection-new-id",
          });
          yield* registry.register(
            new SshConnectionRegistration({
              target: again,
              profile: new SshConnectionProfile({
                ...SSH_PROFILE,
                connectionId: again.connectionId,
              }),
              credential: BEARER_CREDENTIAL,
            }),
          );

          expect(
            routesOf(yield* Ref.get(harness.storedTargets), SSH_CONNECTION.environmentId),
          ).toEqual([again]);
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
  );

  it.effect("signing out of T3 Connect keeps an environment that still has a LAN route", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [LAN_TARGET, RELAY_TARGET, SECOND_RELAY_TARGET],
        [LAN_PROFILE],
        [[LAN_TARGET.connectionId, BEARER_CREDENTIAL]],
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.removeRelayEnvironments();

        const targets = yield* Ref.get(harness.storedTargets);
        expect(routesOf(targets, LAN_TARGET.environmentId)).toEqual([LAN_TARGET]);
        expect(hasRoutes(targets, SECOND_RELAY_TARGET.environmentId)).toBe(false);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([SECOND_RELAY_TARGET.environmentId]);
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(LAN_TARGET.environmentId)?.target,
        ).toEqual(LAN_TARGET);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("reorders routes and rejects an order that drops one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [LAN_TARGET, RELAY_TARGET],
        [LAN_PROFILE],
        [[LAN_TARGET.connectionId, BEARER_CREDENTIAL]],
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.reorderRoutes(LAN_TARGET.environmentId, ["relay", LAN_TARGET.connectionId]);
        expect(routesOf(yield* Ref.get(harness.storedTargets), LAN_TARGET.environmentId)).toEqual([
          RELAY_TARGET,
          LAN_TARGET,
        ]);

        const error = yield* registry
          .reorderRoutes(LAN_TARGET.environmentId, ["relay"])
          .pipe(Effect.flip);
        expect(error._tag).toBe("ConnectionBlockedError");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("removing the last route forgets the environment", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [LAN_TARGET, RELAY_TARGET],
        [LAN_PROFILE],
        [[LAN_TARGET.connectionId, BEARER_CREDENTIAL]],
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.removeRoute(LAN_TARGET.environmentId, LAN_TARGET.connectionId);
        expect(routesOf(yield* Ref.get(harness.storedTargets), LAN_TARGET.environmentId)).toEqual([
          RELAY_TARGET,
        ]);
        expect(yield* Ref.get(harness.cacheClears)).toEqual([]);

        yield* registry.removeRoute(LAN_TARGET.environmentId, "relay");
        expect(hasRoutes(yield* Ref.get(harness.storedTargets), LAN_TARGET.environmentId)).toBe(
          false,
        );
        expect(yield* Ref.get(harness.cacheClears)).toEqual([LAN_TARGET.environmentId]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect(
    "revokes pull request routing trust when a route is added but keeps it on reorder",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness([RELAY_TARGET]);
        let stored: ReadonlyArray<StoredPullRequestRoutingPermission> = [];
        const permissions = yield* makePullRequestRoutingPermissions({
          read: Effect.sync(() => stored),
          write: (next) => Effect.sync(() => void (stored = next)),
        });
        yield* Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          const current = () =>
            SubscriptionRef.get(registry.entries).pipe(
              Effect.map((entries) => entries.get(RELAY_TARGET.environmentId)!),
            );
          yield* permissions.set(yield* current(), "read");
          yield* registry.register(lanRegistration());
          expect(yield* permissions.get(yield* current())).toBe("off");

          yield* permissions.set(yield* current(), "read");
          yield* registry.reorderRoutes(LAN_TARGET.environmentId, [
            "relay",
            LAN_TARGET.connectionId,
          ]);
          expect(yield* permissions.get(yield* current())).toBe("read");
        }).pipe(
          Effect.provide(harness.layer),
          Effect.provideService(PullRequestRoutingPermissions, permissions),
          Effect.scoped,
        );
      }),
  );

  it.effect("loads saved routes grouped by environment, in saved order", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        [LAN_TARGET, BEARER_TARGET, RELAY_TARGET],
        [LAN_PROFILE, BEARER_PROFILE],
        [
          [LAN_TARGET.connectionId, BEARER_CREDENTIAL],
          [BEARER_TARGET.connectionId, BEARER_CREDENTIAL],
        ],
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const entries = yield* SubscriptionRef.get(registry.entries);
        expect([...entries.keys()]).toEqual([
          LAN_TARGET.environmentId,
          BEARER_TARGET.environmentId,
        ]);
        expect(entries.get(LAN_TARGET.environmentId)?.alternateRoutes?.[0]?.target).toEqual(
          RELAY_TARGET,
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("saves the Tailscale mark when the server reports a learned address as tailnet", () =>
    Effect.gen(function* () {
      const httpBaseUrl = "http://100.101.102.103:3773/";
      const learnedId = `learned:${LAN_TARGET.environmentId}:http://100.101.102.103:3773@${LAN_TARGET.connectionId}`;
      const learned = new BearerConnectionTarget({ ...LAN_TARGET, connectionId: learnedId });
      const learnedProfile = new BearerConnectionProfile({
        connectionId: learnedId,
        environmentId: LAN_TARGET.environmentId,
        label: LAN_TARGET.label,
        httpBaseUrl,
        wsBaseUrl: "ws://100.101.102.103:3773/",
        learned: true,
      });
      const harness = yield* makeHarness(
        [LAN_TARGET, learned],
        [LAN_PROFILE, learnedProfile],
        [[LAN_TARGET.connectionId, BEARER_CREDENTIAL]],
        {
          directEndpoints: [
            { kind: "lan", httpBaseUrl: LAN_PROFILE.httpBaseUrl },
            { kind: "tailnet", httpBaseUrl },
          ],
        },
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* SubscriptionRef.changes(registry.entries).pipe(
          Stream.map((entries) => entries.get(LAN_TARGET.environmentId)?.alternateRoutes?.[0]),
          Stream.filter((route) => route !== undefined && connectionRouteKind(route) === "tailnet"),
          Stream.runHead,
        );
        expect((yield* Ref.get(harness.storedProfiles)).get(learnedId)).toMatchObject({
          network: "tailscale",
          learned: true,
          httpBaseUrl,
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("drops a learned route whose profile was not saved instead of duplicating it", () =>
    Effect.gen(function* () {
      const learnedId = `learned:${LAN_TARGET.environmentId}:100.64.0.9:3773@${LAN_TARGET.connectionId}`;
      const learned = new BearerConnectionTarget({ ...LAN_TARGET, connectionId: learnedId });
      const harness = yield* makeHarness(
        [LAN_TARGET, learned, learned],
        [LAN_PROFILE],
        [[LAN_TARGET.connectionId, BEARER_CREDENTIAL]],
      );
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(LAN_TARGET.environmentId);
        expect(entry?.target).toEqual(LAN_TARGET);
        expect(entry?.alternateRoutes ?? []).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
