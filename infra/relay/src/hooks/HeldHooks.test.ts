import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import * as HeldHooks from "./HeldHooks.ts";
import * as HookInbox from "./HookInbox.ts";

const settings = {
  managedEndpointBaseDomain: "example.test",
  managedEndpointNamespace: "dev",
  cloudMintPrivateKey: Redacted.make("unused"),
} as RelayConfiguration.RelayConfiguration["Service"];

const environmentId = "env-hook";
const ownKey = "0123456789abcdef";
const otherKey = "fedcba9876543210";

const allocationFor = (
  userId: string,
  key: string,
  ready: boolean,
): ManagedEndpointAllocations.ManagedEndpointAllocation => ({
  userId,
  environmentId,
  hostname: `${key}.example.test`,
  tunnelId: `tunnel-${key}`,
  tunnelName: `t3coderelay-managedendpoint-dev-${key}`,
  dnsRecordId: "dns-record-id",
  readyAt: ready ? "2026-05-25T00:00:00.000Z" : null,
  tunnelReleasedAt: null,
  origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
  updatedAt: "2026-05-25T00:00:00.000Z",
  generation: 1,
});

const linkFor = (userId: string, key: string, environmentPublicKey: string) => ({
  userId,
  environmentId: environmentId as never,
  label: "Hook env",
  endpoint: {
    httpBaseUrl: `https://${key}.example.test/`,
    wsBaseUrl: `wss://${key}.example.test/ws`,
    providerKind: "cloudflare_tunnel" as const,
  },
  environmentPublicKey,
  linkedAt: "2026-05-25T00:00:00.000Z",
  holdWebhooksWhileOffline: true,
});

/** This environment's own link (user_1) and another account's link of the same environment. */
const withService = <A, E>(
  options: { readonly ownReady?: boolean; readonly pendingKeys?: ReadonlyArray<string> },
  body: (input: {
    readonly heldHooks: HeldHooks.HeldHooks["Service"];
    readonly cleared: Array<string>;
    readonly woken: Array<string>;
  }) => Effect.Effect<A, E>,
) => {
  const cleared: Array<string> = [];
  const woken: Array<string> = [];
  const links = [linkFor("user_1", ownKey, "own-key"), linkFor("user_2", otherKey, "other-key")];
  const allocations = [
    allocationFor("user_1", ownKey, options.ownReady ?? true),
    allocationFor("user_2", otherKey, true),
  ];
  const layerDependencies = Layer.mergeAll(
    Layer.succeed(RelayConfiguration.RelayConfiguration, settings),
    Layer.mock(EnvironmentLinks.EnvironmentLinks, {
      findActiveManagedForEnvironment: (input) =>
        Effect.succeed(
          links.filter(
            (link) =>
              link.environmentId === input.environmentId &&
              (input.userId === undefined || link.userId === input.userId) &&
              (input.environmentPublicKey === undefined ||
                link.environmentPublicKey === input.environmentPublicKey),
          ),
        ),
      setHoldWebhooksWhileOffline: () => Effect.void,
    }),
    Layer.mock(ManagedEndpointAllocations.ManagedEndpointAllocations, {
      get: (input) =>
        Effect.succeed(
          allocations.find((allocation) => allocation.userId === input.userId) ?? null,
        ),
      getByTunnelName: (tunnelName) =>
        Effect.succeed(
          allocations.find((allocation) => allocation.tunnelName === tunnelName) ?? null,
        ),
    }),
    Layer.mock(HookInbox.HookInbox, {
      clear: ({ endpointKey }) => Effect.sync(() => void cleared.push(endpointKey)),
      wake: ({ endpointKey }) =>
        Effect.sync(() => {
          woken.push(endpointKey);
          return (options.pendingKeys ?? []).includes(endpointKey);
        }),
    }),
  );
  return Effect.gen(function* () {
    const heldHooks = yield* HeldHooks.HeldHooks;
    return yield* body({ heldHooks, cleared, woken });
  }).pipe(Effect.provide(HeldHooks.layer.pipe(Layer.provide(layerDependencies))));
};

describe("HeldHooks", () => {
  it.effect("opting out clears only the caller's own endpoints", () =>
    withService({}, ({ heldHooks, cleared }) =>
      Effect.gen(function* () {
        yield* heldHooks.setHoldWhileOffline({
          environmentId,
          environmentPublicKey: "own-key",
          holdWebhooksWhileOffline: false,
        });
        expect(cleared).toEqual([ownKey]);
      }),
    ),
  );

  it.effect("opting in keeps what is held", () =>
    withService({}, ({ heldHooks, cleared }) =>
      Effect.gen(function* () {
        yield* heldHooks.setHoldWhileOffline({
          environmentId,
          environmentPublicKey: "own-key",
          holdWebhooksWhileOffline: true,
        });
        expect(cleared).toEqual([]);
      }),
    ),
  );

  it.effect("wakes the caller's ready endpoints and reports whether anything was waiting", () =>
    withService({ pendingKeys: [ownKey] }, ({ heldHooks, woken }) =>
      Effect.gen(function* () {
        expect(yield* heldHooks.wake({ environmentId, environmentPublicKey: "own-key" })).toBe(
          true,
        );
        expect(woken).toEqual([ownKey]);
      }),
    ),
  );

  it.effect("does not wake an endpoint that is not ready", () =>
    withService({ ownReady: false, pendingKeys: [ownKey] }, ({ heldHooks, woken }) =>
      Effect.gen(function* () {
        expect(yield* heldHooks.wake({ environmentId, environmentPublicKey: "own-key" })).toBe(
          false,
        );
        expect(woken).toEqual([]);
      }),
    ),
  );
});
