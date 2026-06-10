import { EnvironmentId } from "@t3tools/contracts";
import { RelayEnvironmentStatusScope } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  MANAGED_RELAY_REQUEST_TIMEOUT_MS,
  ManagedRelayClient,
  ManagedRelayDpopSigner,
  managedRelayClientLayer,
  type ManagedRelayDpopProofInput,
} from "./managedRelay.ts";
import { remoteHttpClientLayer } from "./remote.ts";

function managedRelayTestLayer(
  fetchFn: typeof globalThis.fetch,
  relayUrl = "https://relay.example.test",
) {
  const httpClientLayer = remoteHttpClientLayer(fetchFn);
  const signerLayer = Layer.succeed(
    ManagedRelayDpopSigner,
    ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed("client-thumbprint"),
      createProof: (input: ManagedRelayDpopProofInput) => Effect.succeed(`proof:${input.url}`),
    }),
  );
  return managedRelayClientLayer({
    relayUrl,
    clientId: "t3-mobile",
  }).pipe(Layer.provide(signerLayer), Layer.provide(httpClientLayer));
}

describe("ManagedRelayClient", () => {
  it.effect("rejects unsafe relay URLs before sending credentials", () => {
    let requestCount = 0;
    const fetchFn = (() => {
      requestCount += 1;
      return Promise.resolve(Response.json({}));
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelayClient;
      const error = yield* relayClient
        .listEnvironments({ clerkToken: "clerk-token" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ManagedRelayClientError",
        message: "Relay URL must be a secure absolute HTTPS origin.",
      });
      expect(requestCount).toBe(0);
    }).pipe(Effect.provide(managedRelayTestLayer(fetchFn, "http://relay.example.test")));
  });

  it.effect("reuses usable DPoP tokens and refreshes cleared or expiring cache entries", () => {
    let tokenExchangeCount = 0;
    const fetchFn = ((input) => {
      const url = String(input);
      if (url.endsWith("/v1/client/dpop-token")) {
        tokenExchangeCount += 1;
        return Promise.resolve(
          Response.json({
            access_token: `relay-token-${tokenExchangeCount}`,
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 10,
            scope: RelayEnvironmentStatusScope,
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "env-1",
          endpoint: {
            httpBaseUrl: "https://desktop.example.test/",
            wsBaseUrl: "wss://desktop.example.test/ws",
            providerKind: "cloudflare_tunnel",
          },
          status: "online",
          checkedAt: "2026-05-25T00:01:00.000Z",
          descriptor: {
            environmentId: "env-1",
            label: "Desktop",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          },
        }),
      );
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelayClient;
      const statusInput = {
        clerkToken: "clerk-token",
        scopes: [RelayEnvironmentStatusScope],
        environmentId: EnvironmentId.make("env-1"),
      } as const;

      yield* relayClient.getEnvironmentStatus(statusInput);
      yield* relayClient.getEnvironmentStatus(statusInput);
      expect(tokenExchangeCount).toBe(1);

      yield* TestClock.adjust(Duration.seconds(6));
      yield* relayClient.getEnvironmentStatus(statusInput);
      expect(tokenExchangeCount).toBe(2);

      yield* relayClient.resetTokenCache;
      yield* relayClient.getEnvironmentStatus(statusInput);
      expect(tokenExchangeCount).toBe(3);
    }).pipe(Effect.provide(managedRelayTestLayer(fetchFn)));
  });

  it.effect("times out stalled relay environment listing requests", () => {
    const fetchFn = (() =>
      new Promise<Response>(() => undefined)) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelayClient;
      const errorFiber = yield* relayClient
        .listEnvironments({ clerkToken: "clerk-token" })
        .pipe(Effect.flip, Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(MANAGED_RELAY_REQUEST_TIMEOUT_MS));
      const error = yield* Fiber.join(errorFiber);

      expect(error).toMatchObject({
        _tag: "ManagedRelayClientError",
        message: "Relay environment listing timed out.",
      });
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managedRelayTestLayer(fetchFn))));
  });

  it.effect("lists account devices through the Clerk bearer client endpoint", () => {
    const fetchFn = ((input, init) => {
      expect(String(input)).toBe("https://relay.example.test/v1/client/devices");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer clerk-token",
      });
      return Promise.resolve(
        Response.json({
          devices: [
            {
              deviceId: "device-1",
              label: "Julius's iPhone",
              platform: "ios",
              iosMajorVersion: 18,
              appVersion: "1.0.0",
              notifications: {
                enabled: false,
                notifyOnApproval: true,
                notifyOnInput: true,
                notifyOnCompletion: true,
                notifyOnFailure: true,
              },
              liveActivities: {
                enabled: true,
              },
              updatedAt: "2026-06-01T00:00:00.000Z",
            },
          ],
        }),
      );
    }) satisfies typeof globalThis.fetch;

    return Effect.gen(function* () {
      const relayClient = yield* ManagedRelayClient;
      const devices = yield* relayClient.listDevices({ clerkToken: "clerk-token" });
      expect(devices).toMatchObject([
        {
          deviceId: "device-1",
          label: "Julius's iPhone",
          notifications: {
            enabled: false,
          },
        },
      ]);
    }).pipe(Effect.provide(managedRelayTestLayer(fetchFn)));
  });
});
