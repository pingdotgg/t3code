import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EnvironmentId } from "@t3tools/contracts";
import { RelayMobileClientId } from "@t3tools/contracts/relay";
import {
  managedRelayClientLayer,
  ManagedRelayClient,
  ManagedRelayDpopSigner,
} from "@t3tools/client-runtime/relay";
import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { HttpClient } from "effect/unstable/http";

import {
  cloudEnvironmentsPendingStatus,
  linkEnvironmentToCloud,
  connectCloudEnvironment,
  listCloudEnvironments,
  listCloudEnvironmentsWithStatus,
  normalizeRelayBaseUrl,
  refreshCloudEnvironmentConnection,
} from "./linkEnvironment";

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

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

vi.mock("../../lib/storage", () => ({
  loadOrCreateAgentAwarenessDeviceId: vi.fn(() => Promise.resolve("device-1")),
  loadPreferences: vi.fn(() => Promise.resolve({})),
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

const stableClerkToken = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ1c2VyXzEyMyJ9.test";

const createProofMock = vi.fn(
  (input: { readonly method: string; readonly url: string; readonly accessToken?: string }) =>
    Effect.succeed(`dpop:${input.method}:${input.url}`),
);
const testDpopSignerLayer = Layer.succeed(
  ManagedRelayDpopSigner,
  ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("client-proof-key-thumbprint"),
    createProof: (input) => createProofMock(input),
  }),
);

function cloudClientLayer() {
  const httpClientLayer = remoteHttpClientLayer((input, init) => globalThis.fetch(input, init));
  return Layer.mergeAll(
    httpClientLayer,
    managedRelayClientLayer({
      relayUrl: "https://relay.example.test",
      clientId: RelayMobileClientId,
    }).pipe(Layer.provideMerge(testDpopSignerLayer), Layer.provide(httpClientLayer)),
  );
}

const withCloudServices = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | ManagedRelayClient | ManagedRelayDpopSigner>,
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

function validDpopAccessTokenResponse(scope = "environment:status environment:connect") {
  return {
    access_token: "relay-dpop-token",
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    token_type: "DPoP",
    expires_in: 300,
    scope,
  };
}

function listedEnvironment(environmentId: string) {
  return {
    environmentId: EnvironmentId.make(environmentId),
    label: "Desktop",
    endpoint: {
      httpBaseUrl: `https://${environmentId}.example.test/`,
      wsBaseUrl: `wss://${environmentId}.example.test/ws`,
      providerKind: "cloudflare_tunnel" as const,
    },
    linkedAt: "2026-05-25T00:00:00.000Z",
  };
}

describe("mobile cloud link environment client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    createProofMock.mockClear();
  });

  it("normalizes configured relay base URLs before building DPoP-bound requests", () => {
    expect(normalizeRelayBaseUrl(" https://relay.example.test/// ")).toBe(
      "https://relay.example.test",
    );
    expect(normalizeRelayBaseUrl("   ")).toBeNull();
  });

  it("makes linked environments visible while their status is still loading", () => {
    expect(cloudEnvironmentsPendingStatus([listedEnvironment("env-1")])).toMatchObject([
      {
        environment: { environmentId: "env-1", label: "Desktop" },
        status: null,
        statusError: "Checking status...",
      },
    ]);
  });

  it.effect("decodes relay environment list responses before returning records", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            Response.json({
              environments: [
                {
                  environmentId: "env-1",
                  label: "Desktop",
                  endpoint: {
                    httpBaseUrl: "https://desktop.example.test/",
                    wsBaseUrl: "wss://desktop.example.test/ws",
                    providerKind: "cloudflare_tunnel",
                  },
                  linkedAt: "2026-05-25T00:00:00.000Z",
                },
              ],
            }),
          ),
        ),
      );

      const records = yield* withCloudServices(
        listCloudEnvironments({ clerkToken: "clerk-token" }),
      );
      expect(records).toEqual([
        {
          environmentId: "env-1",
          label: "Desktop",
          endpoint: {
            httpBaseUrl: "https://desktop.example.test/",
            wsBaseUrl: "wss://desktop.example.test/ws",
            providerKind: "cloudflare_tunnel",
          },
          linkedAt: "2026-05-25T00:00:00.000Z",
        },
      ]);
    }),
  );

  it.effect("rejects malformed relay environment list responses", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            Response.json({
              environments: [
                {
                  environmentId: "env-1",
                  label: "Desktop",
                  endpoint: {
                    httpBaseUrl: "",
                    wsBaseUrl: "wss://desktop.example.test/ws",
                    providerKind: "cloudflare_tunnel",
                  },
                  linkedAt: "2026-05-25T00:00:00.000Z",
                },
              ],
            }),
          ),
        ),
      );

      const error = yield* withCloudServices(
        listCloudEnvironments({ clerkToken: "clerk-token" }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CloudEnvironmentLinkError",
        message: "https://relay.example.test/v1/environments failed",
      });
    }),
  );

  it.effect("loads signed status for each advertised cloud environment", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn((url: string | URL, _init?: RequestInit) => {
        if (String(url) === "https://relay.example.test/v1/environments") {
          return Promise.resolve(
            Response.json({
              environments: [
                {
                  environmentId: "env-1",
                  label: "Desktop",
                  endpoint: {
                    httpBaseUrl: "https://desktop.example.test/",
                    wsBaseUrl: "wss://desktop.example.test/ws",
                    providerKind: "cloudflare_tunnel",
                  },
                  linkedAt: "2026-05-25T00:00:00.000Z",
                },
              ],
            }),
          );
        }
        if (String(url) === "https://relay.example.test/v1/client/dpop-token") {
          return Promise.resolve(Response.json(validDpopAccessTokenResponse()));
        }
        expect(String(url)).toBe("https://relay.example.test/v1/environments/env-1/status");
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
      });
      vi.stubGlobal("fetch", fetchMock);

      const records = yield* withCloudServices(
        listCloudEnvironmentsWithStatus({ clerkToken: "clerk-token" }),
      );
      expect(records).toMatchObject([
        {
          environment: {
            environmentId: "env-1",
            label: "Desktop",
          },
          status: {
            environmentId: "env-1",
            status: "online",
            checkedAt: "2026-05-25T00:01:00.000Z",
          },
          statusError: null,
        },
      ]);
      expect(String(fetchMock.mock.calls[2]?.[0])).toBe(
        "https://relay.example.test/v1/environments/env-1/status",
      );
      expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("POST");
      const statusHeaders = new Headers(fetchMock.mock.calls[2]?.[1]?.headers);
      expect(statusHeaders.get("authorization")).toBe("DPoP relay-dpop-token");
      expect(statusHeaders.get("dpop")).toBe(
        "dpop:POST:https://relay.example.test/v1/environments/env-1/status",
      );
      expect(createProofMock).toHaveBeenCalledWith({
        method: "POST",
        url: "https://relay.example.test/v1/environments/env-1/status",
        accessToken: "relay-dpop-token",
      });
    }),
  );

  it.effect("reuses one valid DPoP access token while probing multiple environment statuses", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn((url: string | URL, _init?: RequestInit) => {
        if (String(url).endsWith("/v1/environments")) {
          return Promise.resolve(
            Response.json({
              environments: [listedEnvironment("env-1"), listedEnvironment("env-2")],
            }),
          );
        }
        if (String(url).endsWith("/v1/client/dpop-token")) {
          return Promise.resolve(Response.json(validDpopAccessTokenResponse()));
        }
        const environmentId = String(url).includes("/env-1/") ? "env-1" : "env-2";
        return Promise.resolve(
          Response.json({
            environmentId,
            endpoint: listedEnvironment(environmentId).endpoint,
            status: "online",
            checkedAt: "2026-05-25T00:01:00.000Z",
            descriptor: {
              environmentId,
              label: "Desktop",
              platform: { os: "darwin", arch: "arm64" },
              serverVersion: "0.0.0-test",
              capabilities: { repositoryIdentity: true },
            },
          }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      yield* withCloudServices(listCloudEnvironmentsWithStatus({ clerkToken: stableClerkToken }));

      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/v1/client/dpop-token")),
      ).toHaveLength(1);
    }),
  );

  it.effect("reuses the status-and-connect token when connecting from the cloud list", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn((url: string | URL, _init?: RequestInit) => {
        if (String(url).endsWith("/v1/environments")) {
          return Promise.resolve(
            Response.json({
              environments: [listedEnvironment("env-1")],
            }),
          );
        }
        if (String(url).endsWith("/v1/client/dpop-token")) {
          return Promise.resolve(Response.json(validDpopAccessTokenResponse()));
        }
        if (String(url).endsWith("/status")) {
          return Promise.resolve(
            Response.json({
              environmentId: "env-1",
              endpoint: listedEnvironment("env-1").endpoint,
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
        }
        if (String(url).endsWith("/connect")) {
          return Promise.resolve(
            Response.json({
              environmentId: "env-1",
              endpoint: listedEnvironment("env-1").endpoint,
              credential: "one-time-cloud-credential",
              expiresAt: "2026-05-25T00:05:00.000Z",
            }),
          );
        }
        if (String(url).endsWith("/.well-known/t3/environment")) {
          return Promise.resolve(
            Response.json({
              environmentId: "env-1",
              label: "Desktop",
              platform: { os: "darwin", arch: "arm64" },
              serverVersion: "0.0.0-test",
              capabilities: { repositoryIdentity: true },
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            access_token: "environment-dpop-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 3600,
            scope: "orchestration:read orchestration:operate terminal:operate review:write",
          }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      yield* withCloudServices(
        Effect.gen(function* () {
          const records = yield* listCloudEnvironmentsWithStatus({
            clerkToken: stableClerkToken,
          });
          yield* connectCloudEnvironment({
            clerkToken: stableClerkToken,
            environment: records[0]!.environment,
          });
        }),
      );

      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/v1/client/dpop-token")),
      ).toHaveLength(1);
      const exchangeRequest = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/v1/client/dpop-token"),
      )?.[1];
      expect(new URLSearchParams(requestBodyText(exchangeRequest?.body)).get("scope")).toBe(
        "environment:status environment:connect",
      );
      const environmentTokenRequest = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/oauth/token"),
      )?.[1];
      const environmentTokenBody = new URLSearchParams(
        requestBodyText(environmentTokenRequest?.body),
      );
      expect(environmentTokenBody.get("client_label")).toBe("T3 Code Mobile");
      expect(environmentTokenBody.get("client_device_type")).toBe("mobile");
      expect(environmentTokenBody.get("client_os")).toBe("iOS");
    }),
  );

  it.effect("keeps advertised environments visible when status probing fails", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string | URL) => {
          if (String(url) === "https://relay.example.test/v1/environments") {
            return Promise.resolve(
              Response.json({
                environments: [
                  {
                    environmentId: "env-1",
                    label: "Desktop",
                    endpoint: {
                      httpBaseUrl: "https://desktop.example.test/",
                      wsBaseUrl: "wss://desktop.example.test/ws",
                      providerKind: "cloudflare_tunnel",
                    },
                    linkedAt: "2026-05-25T00:00:00.000Z",
                  },
                ],
              }),
            );
          }
          if (String(url) === "https://relay.example.test/v1/client/dpop-token") {
            return Promise.resolve(Response.json(validDpopAccessTokenResponse()));
          }
          return Promise.resolve(Response.json({ error: "offline" }, { status: 503 }));
        }),
      );

      const records = yield* withCloudServices(
        listCloudEnvironmentsWithStatus({ clerkToken: "clerk-token" }),
      );
      expect(records).toMatchObject([
        {
          environment: {
            environmentId: "env-1",
            label: "Desktop",
          },
          status: null,
          statusError: "https://relay.example.test/v1/environments/env-1/status failed",
        },
      ]);
    }),
  );

  it.effect("rejects status responses for a different advertised environment", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string | URL) => {
          if (String(url) === "https://relay.example.test/v1/environments") {
            return Promise.resolve(
              Response.json({
                environments: [
                  {
                    environmentId: "env-1",
                    label: "Desktop",
                    endpoint: {
                      httpBaseUrl: "https://desktop.example.test/",
                      wsBaseUrl: "wss://desktop.example.test/ws",
                      providerKind: "cloudflare_tunnel",
                    },
                    linkedAt: "2026-05-25T00:00:00.000Z",
                  },
                ],
              }),
            );
          }
          if (String(url) === "https://relay.example.test/v1/client/dpop-token") {
            return Promise.resolve(Response.json(validDpopAccessTokenResponse()));
          }
          return Promise.resolve(
            Response.json({
              environmentId: "env-other",
              endpoint: {
                httpBaseUrl: "https://desktop.example.test/",
                wsBaseUrl: "wss://desktop.example.test/ws",
                providerKind: "cloudflare_tunnel",
              },
              status: "online",
              checkedAt: "2026-05-25T00:01:00.000Z",
              descriptor: {
                environmentId: "env-other",
                label: "Other Desktop",
                platform: { os: "darwin", arch: "arm64" },
                serverVersion: "0.0.0-test",
                capabilities: { repositoryIdentity: true },
              },
            }),
          );
        }),
      );

      const records = yield* withCloudServices(
        listCloudEnvironmentsWithStatus({ clerkToken: "clerk-token" }),
      );
      expect(records).toMatchObject([
        {
          environment: {
            environmentId: "env-1",
            label: "Desktop",
          },
          status: null,
          statusError: "Relay returned status for a different environment.",
        },
      ]);
    }),
  );

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
          linkEnvironmentToCloud({
            clerkToken: "clerk-token",
            connection: savedConnection,
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
        linkEnvironmentToCloud({
          clerkToken: "clerk-token",
          connection: savedConnection,
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
        linkEnvironmentToCloud({
          clerkToken: "clerk-token",
          connection: savedConnection,
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
        linkEnvironmentToCloud({
          clerkToken: "clerk-token",
          connection: savedConnection,
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
      const storage = yield* Effect.promise(() => import("../../lib/storage"));
      vi.mocked(storage.loadPreferences).mockResolvedValueOnce({
        liveActivitiesEnabled: false,
      });
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
        linkEnvironmentToCloud({
          clerkToken: "clerk-token",
          connection: savedConnection,
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

  it.effect(
    "does not persist cloud connect bootstrap credentials in saved connection records",
    () =>
      Effect.gen(function* () {
        let connectRequestBody = "";
        const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
          if (String(url).endsWith("/v1/client/dpop-token")) {
            return Promise.resolve(
              Response.json(validDpopAccessTokenResponse("environment:connect")),
            );
          }
          if (String(url).endsWith("/.well-known/t3/environment")) {
            return Promise.resolve(
              Response.json({
                environmentId: "env-1",
                label: "Desktop",
                platform: { os: "darwin", arch: "arm64" },
                serverVersion: "0.0.0-test",
                capabilities: { repositoryIdentity: true },
              }),
            );
          }
          if (String(url).endsWith("/oauth/token")) {
            return Promise.resolve(
              Response.json({
                access_token: "environment-dpop-token",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "DPoP",
                expires_in: 3600,
                scope: "orchestration:read orchestration:operate terminal:operate review:write",
              }),
            );
          }
          connectRequestBody = requestBodyText(init?.body);
          return Promise.resolve(
            Response.json({
              environmentId: "env-1",
              endpoint: {
                httpBaseUrl: "https://desktop.example.test/",
                wsBaseUrl: "wss://desktop.example.test/ws",
                providerKind: "cloudflare_tunnel",
              },
              credential: "one-time-cloud-credential",
              expiresAt: "2026-05-25T00:05:00.000Z",
            }),
          );
        });
        vi.stubGlobal("fetch", fetchMock);

        const connection = yield* withCloudServices(
          connectCloudEnvironment({
            clerkToken: "clerk-token",
            environment: {
              environmentId: EnvironmentId.make("env-1"),
              label: "Desktop",
              endpoint: {
                httpBaseUrl: "https://desktop.example.test/",
                wsBaseUrl: "wss://desktop.example.test/ws",
                providerKind: "cloudflare_tunnel",
              },
              linkedAt: "2026-05-25T00:00:00.000Z",
            },
          }),
        );

        expect(connection.pairingUrl).toBe("https://desktop.example.test/");
        expect(connection.pairingUrl).not.toContain("one-time-cloud-credential");
        expect(connection.bearerToken).toBeNull();
        expect(connection.authenticationMethod).toBe("dpop");
        expect(connection.dpopAccessToken).toBe("environment-dpop-token");
        expect(connection.relayManaged).toBe(true);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        expect(JSON.parse(connectRequestBody)).toMatchObject({
          deviceId: "device-1",
          clientKeyThumbprint: "client-proof-key-thumbprint",
        });
        expect(createProofMock).toHaveBeenCalledWith({
          method: "POST",
          url: "https://relay.example.test/v1/environments/env-1/connect",
          accessToken: "relay-dpop-token",
        });
        expect(createProofMock).toHaveBeenCalledWith({
          method: "POST",
          url: "https://desktop.example.test/oauth/token",
        });
      }),
  );

  it.effect("refreshes a saved environment against a rotated managed endpoint", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string | URL) => {
          if (String(url).endsWith("/v1/client/dpop-token")) {
            return Promise.resolve(
              Response.json(validDpopAccessTokenResponse("environment:connect")),
            );
          }
          if (String(url).endsWith("/.well-known/t3/environment")) {
            return Promise.resolve(
              Response.json({
                environmentId: "env-1",
                label: "Rotated Desktop",
                platform: { os: "darwin", arch: "arm64" },
                serverVersion: "0.0.0-test",
                capabilities: { repositoryIdentity: true },
              }),
            );
          }
          if (String(url).endsWith("/oauth/token")) {
            return Promise.resolve(
              Response.json({
                access_token: "fresh-environment-dpop-token",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "DPoP",
                expires_in: 3600,
                scope: "orchestration:read orchestration:operate terminal:operate review:write",
              }),
            );
          }
          return Promise.resolve(
            Response.json({
              environmentId: "env-1",
              endpoint: {
                httpBaseUrl: "https://rotated-desktop.example.test/",
                wsBaseUrl: "wss://rotated-desktop.example.test/ws",
                providerKind: "cloudflare_tunnel",
              },
              credential: "rotated-one-time-cloud-credential",
              expiresAt: "2026-05-25T00:05:00.000Z",
            }),
          );
        }),
      );

      const connection = yield* withCloudServices(
        refreshCloudEnvironmentConnection({
          clerkToken: "clerk-token",
          connection: {
            environmentId: EnvironmentId.make("env-1"),
            environmentLabel: "Desktop",
            pairingUrl: "https://desktop.example.test/",
            displayUrl: "https://desktop.example.test/",
            httpBaseUrl: "https://desktop.example.test/",
            wsBaseUrl: "wss://desktop.example.test/ws",
            bearerToken: null,
            authenticationMethod: "dpop",
            relayManaged: true,
          },
        }),
      );

      expect(connection).toMatchObject({
        environmentId: "env-1",
        environmentLabel: "Rotated Desktop",
        displayUrl: "https://rotated-desktop.example.test/",
        httpBaseUrl: "https://rotated-desktop.example.test/",
        wsBaseUrl: "wss://rotated-desktop.example.test/ws",
        dpopAccessToken: "fresh-environment-dpop-token",
      });
    }),
  );

  it.effect("rejects relay connect responses for a different environment", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string | URL) =>
          Promise.resolve(
            String(url).endsWith("/v1/client/dpop-token")
              ? Response.json(validDpopAccessTokenResponse("environment:connect"))
              : Response.json({
                  environmentId: "env-other",
                  endpoint: {
                    httpBaseUrl: "https://desktop.example.test/",
                    wsBaseUrl: "wss://desktop.example.test/ws",
                    providerKind: "cloudflare_tunnel",
                  },
                  credential: "one-time-cloud-credential",
                  expiresAt: "2026-05-25T00:05:00.000Z",
                }),
          ),
        ),
      );

      const error = yield* withCloudServices(
        connectCloudEnvironment({
          clerkToken: "clerk-token",
          environment: {
            environmentId: EnvironmentId.make("env-1"),
            label: "Desktop",
            endpoint: {
              httpBaseUrl: "https://desktop.example.test/",
              wsBaseUrl: "wss://desktop.example.test/ws",
              providerKind: "cloudflare_tunnel",
            },
            linkedAt: "2026-05-25T00:00:00.000Z",
          },
        }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CloudEnvironmentLinkError",
        message: "Relay returned credentials for a different environment.",
      });
    }),
  );

  it.effect("preserves relay DPoP auth failures while connecting environments", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string | URL) =>
          Promise.resolve(
            String(url).endsWith("/v1/client/dpop-token")
              ? Response.json(validDpopAccessTokenResponse("environment:connect"))
              : Response.json(
                  {
                    _tag: "RelayAuthInvalidError",
                    code: "auth_invalid",
                    reason: "invalid_dpop",
                    traceId: "trace-connect",
                  },
                  { status: 401 },
                ),
          ),
        ),
      );

      const error = yield* withCloudServices(
        connectCloudEnvironment({
          clerkToken: "clerk-token",
          environment: {
            environmentId: EnvironmentId.make("env-1"),
            label: "Desktop",
            endpoint: {
              httpBaseUrl: "https://desktop.example.test/",
              wsBaseUrl: "wss://desktop.example.test/ws",
              providerKind: "cloudflare_tunnel",
            },
            linkedAt: "2026-05-25T00:00:00.000Z",
          },
        }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CloudEnvironmentLinkError",
        message:
          "https://relay.example.test/v1/environments/env-1/connect failed: Relay rejected the DPoP proof.",
        traceId: "trace-connect",
      });
    }),
  );

  it.effect("rejects relay connect responses for a different endpoint", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string | URL) =>
          Promise.resolve(
            String(url).endsWith("/v1/client/dpop-token")
              ? Response.json(validDpopAccessTokenResponse("environment:connect"))
              : Response.json({
                  environmentId: "env-1",
                  endpoint: {
                    httpBaseUrl: "https://other-desktop.example.test/",
                    wsBaseUrl: "wss://other-desktop.example.test/ws",
                    providerKind: "cloudflare_tunnel",
                  },
                  credential: "one-time-cloud-credential",
                  expiresAt: "2026-05-25T00:05:00.000Z",
                }),
          ),
        ),
      );

      const error = yield* withCloudServices(
        connectCloudEnvironment({
          clerkToken: "clerk-token",
          environment: {
            environmentId: EnvironmentId.make("env-1"),
            label: "Desktop",
            endpoint: {
              httpBaseUrl: "https://desktop.example.test/",
              wsBaseUrl: "wss://desktop.example.test/ws",
              providerKind: "cloudflare_tunnel",
            },
            linkedAt: "2026-05-25T00:00:00.000Z",
          },
        }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CloudEnvironmentLinkError",
        message: "Relay returned credentials for a different endpoint.",
      });
    }),
  );

  it.effect(
    "rejects managed endpoints whose descriptor does not match the selected environment",
    () =>
      Effect.gen(function* () {
        vi.stubGlobal(
          "fetch",
          vi.fn((url: string | URL) =>
            Promise.resolve(
              String(url).endsWith("/v1/client/dpop-token")
                ? Response.json(validDpopAccessTokenResponse("environment:connect"))
                : String(url).endsWith("/.well-known/t3/environment")
                  ? Response.json({
                      environmentId: "env-other",
                      label: "Other Desktop",
                      platform: { os: "darwin", arch: "arm64" },
                      serverVersion: "0.0.0-test",
                      capabilities: { repositoryIdentity: true },
                    })
                  : Response.json({
                      environmentId: "env-1",
                      endpoint: {
                        httpBaseUrl: "https://desktop.example.test/",
                        wsBaseUrl: "wss://desktop.example.test/ws",
                        providerKind: "cloudflare_tunnel",
                      },
                      credential: "one-time-cloud-credential",
                      expiresAt: "2026-05-25T00:05:00.000Z",
                    }),
            ),
          ),
        );

        const error = yield* withCloudServices(
          connectCloudEnvironment({
            clerkToken: "clerk-token",
            environment: {
              environmentId: EnvironmentId.make("env-1"),
              label: "Desktop",
              endpoint: {
                httpBaseUrl: "https://desktop.example.test/",
                wsBaseUrl: "wss://desktop.example.test/ws",
                providerKind: "cloudflare_tunnel",
              },
              linkedAt: "2026-05-25T00:00:00.000Z",
            },
          }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "CloudEnvironmentLinkError",
          message: "Connected endpoint descriptor does not match the selected environment.",
        });
      }),
  );
});
