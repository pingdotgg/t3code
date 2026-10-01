import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EnvironmentId } from "@t3tools/contracts";
import { RelayMobileClientId } from "@t3tools/contracts/relay";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { HttpClient } from "effect/unstable/http";

import { MobileStorage } from "../../persistence/mobile-storage";

import { linkEnvironmentToCloudWithPreference } from "./linkEnvironment";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        relay: {
          url: "https://relay.example.test",
        },
      },
    },
  },
}));

vi.mock("expo-device", () => ({
  deviceType: 1,
  DeviceType: {
    UNKNOWN: 0,
    PHONE: 1,
    TABLET: 2,
    DESKTOP: 3,
    TV: 4,
  },
  osVersion: "18.4.1",
  modelName: "iPhone 15 Pro",
}));

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

const savedConnection = {
  environmentId: EnvironmentId.make("env-1"),
  environmentLabel: "Desktop",
  pairingUrl: "https://desktop.example.test/",
  displayUrl: "https://desktop.example.test/",
  httpBaseUrl: "https://desktop.example.test/",
  wsBaseUrl: "wss://desktop.example.test/ws",
  bearerToken: "local-bearer",
};

const createProofMock = vi.fn(
  (input: { readonly method: string; readonly url: string; readonly accessToken?: string }) =>
    Effect.succeed(`dpop:${input.method}:${input.url}`),
);
const testDpopSignerLayer = Layer.succeed(
  ManagedRelay.ManagedRelayDpopSigner,
  ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("client-proof-key-thumbprint"),
    createProof: (input) => createProofMock(input),
  }),
);

function cloudClientLayer() {
  const httpClientLayer = remoteHttpClientLayer((input, init) => globalThis.fetch(input, init));
  return Layer.mergeAll(
    httpClientLayer,
    Layer.succeed(
      MobileStorage,
      MobileStorage.of({
        loadSavedConnections: Effect.succeed([]),
        saveConnection: () => Effect.void,
        clearSavedConnection: () => Effect.void,
        loadOrCreateAgentAwarenessDeviceId: Effect.succeed("device-1"),
        loadAgentAwarenessDeviceId: Effect.succeed("device-1"),
        loadAgentAwarenessRegistrationRecord: Effect.succeed(null),
        saveAgentAwarenessRegistrationRecord: () => Effect.void,
        clearAgentAwarenessRegistrationRecord: Effect.void,
        loadRecentThreadShortcuts: Effect.succeed([]),
        saveRecentThreadShortcuts: () => Effect.void,
      }),
    ),
    ManagedRelay.layer({
      relayUrl: "https://relay.example.test",
      clientId: RelayMobileClientId,
    }).pipe(Layer.provideMerge(testDpopSignerLayer), Layer.provide(httpClientLayer)),
  );
}

const withCloudServices = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | HttpClient.HttpClient
    | ManagedRelay.ManagedRelayClient
    | ManagedRelay.ManagedRelayDpopSigner
    | MobileStorage
  >,
) => effect.pipe(Effect.provide(cloudClientLayer()));

function validLinkProof() {
  return "signed-environment-link-jwt";
}

function validLinkResponse(environmentId = "env-1") {
  return {
    ok: true,
    environmentId,
    endpoint: {
      httpBaseUrl: "https://managed.example.test/",
      wsBaseUrl: "wss://managed.example.test/ws",
      providerKind: "cloudflare_tunnel",
    },
    endpointRuntime: {
      providerKind: "cloudflare_tunnel",
      connectorToken: "connector-token",
    },
    relayIssuer: "https://relay.example.test",
    cloudUserId: "user_123",
    environmentCredential: "environment-credential",
    cloudMintPublicKey: "cloud-mint-public-key",
  };
}

function validLinkChallengeResponse() {
  return {
    challenge: "link-challenge",
    expiresAt: "2026-05-25T00:05:00.000Z",
  };
}

function requestBodyText(body: BodyInit | null | undefined): string {
  return body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body ?? "");
}

describe("mobile cloud link environment client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    createProofMock.mockClear();
  });

  it.effect(
    "rejects relay link credentials for a different environment before persisting relay config",
    () =>
      Effect.gen(function* () {
        const fetchMock = vi.fn((url: string | URL) => {
          if (String(url).endsWith("/v1/client/environment-link-challenges")) {
            return Promise.resolve(Response.json(validLinkChallengeResponse()));
          }
          if (String(url).endsWith("/api/connect/link-proof")) {
            return Promise.resolve(Response.json(validLinkProof()));
          }
          return Promise.resolve(Response.json(validLinkResponse("env-other")));
        });
        vi.stubGlobal("fetch", fetchMock);

        const error = yield* withCloudServices(
          linkEnvironmentToCloudWithPreference({
            clerkToken: "clerk-token",
            connection: savedConnection,
            liveActivitiesEnabled: true,
          }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "CloudEnvironmentLinkError",
          message: "Relay returned credentials for a different environment.",
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
      }),
  );

  it.effect("preserves typed local environment failures while obtaining a link proof", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn((url: string | URL) => {
        if (String(url).endsWith("/v1/client/environment-link-challenges")) {
          return Promise.resolve(Response.json(validLinkChallengeResponse()));
        }
        return Promise.resolve(
          Response.json(
            {
              _tag: "EnvironmentHttpUnauthorizedError",
              message: "Invalid environment bearer session.",
            },
            { status: 401 },
          ),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const error = yield* withCloudServices(
        linkEnvironmentToCloudWithPreference({
          clerkToken: "clerk-token",
          connection: savedConnection,
          liveActivitiesEnabled: true,
        }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("CloudEnvironmentLinkError");
      expect(error.message).toBe(
        "Could not obtain environment link proof: Invalid environment bearer session.",
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("preserves typed relay error bodies while linking environments", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn((url: string | URL) => {
        if (String(url).endsWith("/v1/client/environment-link-challenges")) {
          return Promise.resolve(Response.json(validLinkChallengeResponse()));
        }
        if (String(url).endsWith("/api/connect/link-proof")) {
          return Promise.resolve(Response.json(validLinkProof()));
        }
        return Promise.resolve(
          Response.json(
            {
              _tag: "RelayEnvironmentLinkProofInvalidError",
              code: "environment_link_proof_invalid",
              reason: "origin_not_allowed",
              traceId: "trace-test",
            },
            { status: 400 },
          ),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const error = yield* withCloudServices(
        linkEnvironmentToCloudWithPreference({
          clerkToken: "clerk-token",
          connection: savedConnection,
          liveActivitiesEnabled: true,
        }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CloudEnvironmentLinkError",
        message:
          "https://relay.example.test/v1/client/environment-links failed: Relay rejected the environment link proof (origin_not_allowed).",
        traceId: "trace-test",
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }),
  );

  it.effect("rejects relay link credentials for a different managed endpoint provider", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn((url: string | URL) => {
        if (String(url).endsWith("/v1/client/environment-link-challenges")) {
          return Promise.resolve(Response.json(validLinkChallengeResponse()));
        }
        if (String(url).endsWith("/api/connect/link-proof")) {
          return Promise.resolve(Response.json(validLinkProof()));
        }
        return Promise.resolve(
          Response.json({
            ...validLinkResponse(),
            endpoint: {
              ...validLinkResponse().endpoint,
              providerKind: "manual",
            },
          }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const error = yield* withCloudServices(
        linkEnvironmentToCloudWithPreference({
          clerkToken: "clerk-token",
          connection: savedConnection,
          liveActivitiesEnabled: true,
        }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CloudEnvironmentLinkError",
        message: "Relay returned credentials for a different endpoint provider.",
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }),
  );

  it.effect("preserves disabled Live Activity preferences when linking an environment", () =>
    Effect.gen(function* () {
      const bodies: Array<unknown> = [];
      const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
        if (init?.body) {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          bodies.push(JSON.parse(requestBodyText(init.body)));
        }
        if (String(url).endsWith("/v1/client/environment-link-challenges")) {
          return Promise.resolve(Response.json(validLinkChallengeResponse()));
        }
        if (String(url).endsWith("/api/connect/link-proof")) {
          return Promise.resolve(Response.json(validLinkProof()));
        }
        if (String(url).endsWith("/v1/client/environment-links")) {
          return Promise.resolve(Response.json(validLinkResponse()));
        }
        return Promise.resolve(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "configured" } }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      yield* withCloudServices(
        linkEnvironmentToCloudWithPreference({
          clerkToken: "clerk-token",
          connection: savedConnection,
          liveActivitiesEnabled: false,
        }),
      );

      expect(bodies[1]).toMatchObject({
        endpoint: {
          httpBaseUrl: "https://desktop.example.test/",
          wsBaseUrl: "wss://desktop.example.test/ws",
          providerKind: "cloudflare_tunnel",
        },
        origin: {
          localHttpHost: "127.0.0.1",
          localHttpPort: 443,
        },
      });
      expect(bodies[2]).toMatchObject({
        deviceId: "device-1",
        notificationsEnabled: true,
        liveActivitiesEnabled: false,
        managedTunnelsEnabled: true,
      });
      expect(bodies[3]).toMatchObject({
        cloudUserId: "user_123",
        environmentCredential: "environment-credential",
      });
    }),
  );

  it.effect("enables Live Activities for both the link challenge and registration", () =>
    Effect.gen(function* () {
      const bodies: Array<Record<string, unknown>> = [];
      const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
        if (init?.body) {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          bodies.push(JSON.parse(requestBodyText(init.body)) as Record<string, unknown>);
        }
        if (String(url).endsWith("/v1/client/environment-link-challenges")) {
          return Promise.resolve(Response.json(validLinkChallengeResponse()));
        }
        if (String(url).endsWith("/api/connect/link-proof")) {
          return Promise.resolve(Response.json(validLinkProof()));
        }
        if (String(url).endsWith("/v1/client/environment-links")) {
          return Promise.resolve(Response.json(validLinkResponse()));
        }
        return Promise.resolve(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "configured" } }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      yield* withCloudServices(
        linkEnvironmentToCloudWithPreference({
          clerkToken: "clerk-token",
          connection: savedConnection,
          liveActivitiesEnabled: true,
        }),
      );

      expect(bodies.filter((body) => "liveActivitiesEnabled" in body)).toEqual([
        expect.objectContaining({ liveActivitiesEnabled: true }),
        expect.objectContaining({ liveActivitiesEnabled: true }),
      ]);
    }),
  );
});
