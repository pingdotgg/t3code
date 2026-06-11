import { EnvironmentId } from "@t3tools/contracts";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import {
  managedRelayClientLayer,
  ManagedRelayClient,
  ManagedRelayDpopSigner,
  remoteHttpClientLayer,
} from "@t3tools/client-runtime";

import type { SavedEnvironmentRecord } from "../environments/runtime";
import {
  connectManagedCloudEnvironment,
  linkEnvironmentToCloud,
  linkPrimaryEnvironmentToCloud,
  listManagedCloudEnvironments,
  normalizeRelayBaseUrl,
  readPrimaryCloudLinkState,
  unlinkPrimaryEnvironmentFromCloud,
} from "./linkEnvironment";
import {
  readPrimaryEnvironmentDescriptor,
  readPrimaryEnvironmentTarget,
  resolvePrimaryEnvironmentHttpUrl,
} from "../environments/primary";

const getSavedEnvironmentSecretMock = vi.fn();
const relayClientInstallDialogHarness = vi.hoisted(() => ({
  requestConfirmation: vi.fn(),
  reportProgress: vi.fn(),
  finish: vi.fn(),
}));
const getRelayClientStatusMock = vi.fn();
const installRelayClientMock = vi.fn();
const environmentConnectionMock = {
  client: {
    cloud: {
      getRelayClientStatus: getRelayClientStatusMock,
      installRelayClient: installRelayClientMock,
    },
  },
};

const createProofMock = vi.fn(
  (_input: { readonly method: string; readonly url: string; readonly accessToken?: string }) =>
    Effect.succeed("web-dpop-proof"),
);
const testDpopSignerLayer = Layer.succeed(
  ManagedRelayDpopSigner,
  ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("web-thumbprint"),
    createProof: (input) => createProofMock(input),
  }),
);

function cloudClientLayer() {
  const httpClientLayer = remoteHttpClientLayer(globalThis.fetch);
  return Layer.mergeAll(
    httpClientLayer,
    managedRelayClientLayer({
      relayUrl: "https://relay.example.test",
      clientId: RelayWebClientId,
    }).pipe(Layer.provideMerge(testDpopSignerLayer), Layer.provide(httpClientLayer)),
  );
}

const withCloudServices = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | ManagedRelayClient | ManagedRelayDpopSigner>,
) => effect.pipe(Effect.provide(cloudClientLayer()));

vi.mock("../localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getSavedEnvironmentSecret: getSavedEnvironmentSecretMock,
    },
  }),
}));

vi.mock("./relayClientInstallDialog", () => ({
  requestRelayClientInstallConfirmation: relayClientInstallDialogHarness.requestConfirmation,
  reportRelayClientInstallProgress: relayClientInstallDialogHarness.reportProgress,
  finishRelayClientInstall: relayClientInstallDialogHarness.finish,
}));

vi.mock("../environments/primary", () => ({
  readPrimaryEnvironmentDescriptor: vi.fn(() => null),
  readPrimaryEnvironmentTarget: vi.fn(() => null),
  resolvePrimaryEnvironmentHttpUrl: vi.fn((path: string) => `http://127.0.0.1:3000${path}`),
}));

vi.mock("../environments/runtime", () => ({
  getPrimaryEnvironmentConnection: () => environmentConnectionMock,
  readEnvironmentConnection: () => environmentConnectionMock,
}));

const savedEnvironment: SavedEnvironmentRecord = {
  environmentId: EnvironmentId.make("env-1"),
  label: "Desktop",
  httpBaseUrl: "http://127.0.0.1:3000",
  wsBaseUrl: "ws://127.0.0.1:3000",
  createdAt: "2026-05-25T00:00:00.000Z",
  lastConnectedAt: null,
};

function validProof() {
  return "signed-environment-link-jwt";
}

function validChallenge() {
  return {
    challenge: "link-challenge",
    expiresAt: "2026-05-25T00:05:00.000Z",
  };
}

function availableRelayClient() {
  return {
    status: "available",
    executablePath: "/Users/test/.t3/tools/cloudflared/cloudflared",
    source: "managed",
    version: "2026.5.2",
  };
}

function requestBodyText(body: BodyInit | null | undefined): string {
  return body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body ?? "");
}

describe("web cloud link environment client", () => {
  afterEach(() => {
    if ("window" in globalThis) {
      Reflect.deleteProperty(window, "desktopBridge");
    }
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    createProofMock.mockClear();
    vi.stubEnv("VITE_MORECODE_T3CODE_RELAY_URL", "https://relay.example.test");
    getSavedEnvironmentSecretMock.mockResolvedValue("local-bearer");
    relayClientInstallDialogHarness.requestConfirmation.mockResolvedValue(true);
    getRelayClientStatusMock.mockResolvedValue(availableRelayClient());
    installRelayClientMock.mockResolvedValue(availableRelayClient());
    vi.mocked(readPrimaryEnvironmentDescriptor).mockReturnValue(null);
    vi.mocked(readPrimaryEnvironmentTarget).mockReturnValue(null);
    vi.mocked(resolvePrimaryEnvironmentHttpUrl).mockImplementation(
      (path: string) => `http://127.0.0.1:3000${path}`,
    );
  });

  it("normalizes configured relay base URLs before building relay requests", () => {
    expect(normalizeRelayBaseUrl(" https://relay.example.test/// ")).toBe(
      "https://relay.example.test",
    );
    expect(normalizeRelayBaseUrl("   ")).toBeNull();
  });

  it.effect(
    "installs the relay client over environment RPC before requesting a cloud challenge",
    () =>
      Effect.gen(function* () {
        getRelayClientStatusMock.mockResolvedValue({
          status: "missing",
          version: "2026.5.2",
        });
        vi.mocked(readPrimaryEnvironmentDescriptor).mockReturnValue({
          environmentId: EnvironmentId.make("env-1"),
          label: "Desktop",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        });
        vi.mocked(readPrimaryEnvironmentTarget).mockReturnValue({
          source: "desktop-managed",
          target: {
            httpBaseUrl: "http://127.0.0.1:3000",
            wsBaseUrl: "ws://127.0.0.1:3000",
          },
        });
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(Response.json(validChallenge()))
          .mockResolvedValueOnce(Response.json({ malformed: true }));
        vi.stubGlobal("fetch", fetchMock);
        installRelayClientMock.mockImplementationOnce(async (onProgress) => {
          onProgress({ type: "progress", stage: "downloading" });
          return availableRelayClient();
        });

        yield* withCloudServices(
          linkPrimaryEnvironmentToCloud({
            clerkToken: "clerk-token",
          }),
        ).pipe(Effect.flip);

        expect(relayClientInstallDialogHarness.requestConfirmation).toHaveBeenCalledWith(
          "2026.5.2",
        );
        expect(getRelayClientStatusMock).toHaveBeenCalledOnce();
        expect(installRelayClientMock).toHaveBeenCalledOnce();
        expect(relayClientInstallDialogHarness.reportProgress).toHaveBeenCalledWith({
          type: "progress",
          stage: "downloading",
        });
        expect(relayClientInstallDialogHarness.finish).toHaveBeenCalledOnce();
        expect(installRelayClientMock.mock.invocationCallOrder[0]).toBeLessThan(
          fetchMock.mock.invocationCallOrder[0]!,
        );
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
          "https://relay.example.test/v1/client/environment-link-challenges",
        );
      }),
  );

  it.effect("lists relay-managed environments for hosted and served web clients", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        Response.json({
          environments: [
            {
              environmentId: "env-1",
              label: "Managed desktop",
              endpoint: {
                httpBaseUrl: "https://managed.example.test",
                wsBaseUrl: "wss://managed.example.test",
                providerKind: "cloudflare_tunnel",
              },
              linkedAt: "2026-05-25T00:00:00.000Z",
            },
          ],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const environments = yield* withCloudServices(
        listManagedCloudEnvironments({ clerkToken: "clerk-token" }),
      );
      expect(environments).toHaveLength(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "https://relay.example.test/v1/environments",
      );
      expect(fetchMock.mock.calls[0]?.[1]?.headers.authorization).toBe("Bearer clerk-token");
      expect(fetchMock.mock.calls[0]?.[1]?.credentials).not.toBe("include");
    }),
  );

  it.effect("connects web clients to managed environments with a tunnel-only DPoP token", () =>
    Effect.gen(function* () {
      const environment = {
        environmentId: EnvironmentId.make("env-1"),
        label: "Managed desktop",
        endpoint: {
          httpBaseUrl: "https://managed.example.test",
          wsBaseUrl: "wss://managed.example.test",
          providerKind: "cloudflare_tunnel" as const,
        },
        linkedAt: "2026-05-25T00:00:00.000Z",
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            access_token: "relay-access-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 300,
            scope: "environment:connect",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            environmentId: "env-1",
            endpoint: environment.endpoint,
            credential: "environment-bootstrap",
            expiresAt: "2026-05-25T00:05:00.000Z",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            environmentId: "env-1",
            label: "Managed desktop",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            access_token: "environment-access-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "DPoP",
            expires_in: 3600,
            scope: "orchestration:read orchestration:operate terminal:operate review:write",
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const connection = yield* withCloudServices(
        connectManagedCloudEnvironment({ clerkToken: "clerk-token", environment }),
      );
      expect(connection).toMatchObject({
        environmentId: "env-1",
        accessToken: "environment-access-token",
      });

      const tokenBody = requestBodyText(fetchMock.mock.calls[0]?.[1]?.body);
      expect(new URLSearchParams(tokenBody).get("client_id")).toBe("t3-web");
      expect(new URLSearchParams(tokenBody).get("scope")).toBe("environment:connect");
      expect(fetchMock.mock.calls[1]?.[1]?.headers.authorization).toBe("DPoP relay-access-token");
      expect(fetchMock.mock.calls[1]?.[1]?.headers.dpop).toBe("web-dpop-proof");
      expect(createProofMock).toHaveBeenCalledWith({
        method: "POST",
        url: "https://managed.example.test/oauth/token",
      });
    }),
  );

  it.effect("rejects a stored managed connection for another relay origin", () =>
    Effect.gen(function* () {
      const environment = {
        environmentId: EnvironmentId.make("env-1"),
        label: "Managed desktop",
        endpoint: {
          httpBaseUrl: "https://managed.example.test",
          wsBaseUrl: "wss://managed.example.test",
          providerKind: "cloudflare_tunnel" as const,
        },
        linkedAt: "2026-05-25T00:00:00.000Z",
      };

      const error = yield* withCloudServices(
        connectManagedCloudEnvironment({
          clerkToken: "clerk-token",
          environment,
          relayUrl: "https://old-relay.example.test",
        }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        message: "The saved environment is linked through a different configured relay.",
      });
    }),
  );

  it.effect("rejects malformed local environment link proofs", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(Response.json(validChallenge()))
          .mockResolvedValueOnce(
            Response.json({
              payload: {
                environmentId: "env-1",
              },
              signature: "signature-1",
            }),
          ),
      );

      const error = yield* withCloudServices(
        linkEnvironmentToCloud({
          environment: savedEnvironment,
          clerkToken: "clerk-token",
        }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CloudEnvironmentLinkError",
        message: "Could not obtain environment link proof.",
      });
    }),
  );

  it.effect("preserves typed local environment failures while obtaining a link proof", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(Response.json(validChallenge()))
          .mockResolvedValueOnce(
            Response.json(
              {
                _tag: "EnvironmentHttpUnauthorizedError",
                message: "Invalid environment bearer session.",
              },
              { status: 401 },
            ),
          ),
      );

      const error = yield* withCloudServices(
        linkEnvironmentToCloud({
          environment: savedEnvironment,
          clerkToken: "clerk-token",
        }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("CloudEnvironmentLinkError");
      expect(error.message).toBe(
        "Could not obtain environment link proof: Invalid environment bearer session.",
      );
    }),
  );

  it.effect("rejects malformed relay environment link responses", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(Response.json(validChallenge()))
          .mockResolvedValueOnce(Response.json(validProof()))
          .mockResolvedValueOnce(
            Response.json({
              ok: true,
              environmentId: "env-1",
              endpoint: {
                httpBaseUrl: "https://desktop.example.test",
                wsBaseUrl: "wss://desktop.example.test",
                providerKind: "cloudflare_tunnel",
              },
              endpointRuntime: null,
              relayIssuer: "https://issuer.example.test",
              cloudUserId: "user_123",
              environmentCredential: "",
              cloudMintPublicKey: "cloud-mint-public-key",
            }),
          ),
      );

      const error = yield* withCloudServices(
        linkEnvironmentToCloud({
          environment: savedEnvironment,
          clerkToken: "clerk-token",
        }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CloudEnvironmentLinkError",
        message: "https://relay.example.test/v1/client/environment-links failed",
      });
    }),
  );

  it.effect(
    "links the primary local environment through the relay using the owner cookie session",
    () =>
      Effect.gen(function* () {
        vi.mocked(readPrimaryEnvironmentDescriptor).mockReturnValue({
          environmentId: EnvironmentId.make("env-1"),
          label: "Desktop",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        });
        vi.mocked(readPrimaryEnvironmentTarget).mockReturnValue({
          source: "desktop-managed",
          target: {
            httpBaseUrl: "http://127.0.0.1:3000",
            wsBaseUrl: "ws://127.0.0.1:3000",
          },
        });
        vi.mocked(resolvePrimaryEnvironmentHttpUrl).mockImplementation(
          (path: string) => `http://127.0.0.1:3000${path}`,
        );

        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(Response.json(validChallenge()))
          .mockResolvedValueOnce(Response.json(validProof()))
          .mockResolvedValueOnce(
            Response.json({
              ok: true,
              environmentId: "env-1",
              endpoint: {
                httpBaseUrl: "https://desktop.example.test",
                wsBaseUrl: "wss://desktop.example.test",
                providerKind: "cloudflare_tunnel",
              },
              endpointRuntime: {
                providerKind: "cloudflare_tunnel",
                connectorToken: "connector-token",
                tunnelId: "tunnel-id",
                tunnelName: "tunnel-name",
              },
              relayIssuer: "https://issuer.example.test",
              cloudUserId: "user_123",
              environmentCredential: "t3env_test_credential",
              cloudMintPublicKey: "cloud-mint-public-key",
            }),
          )
          .mockResolvedValueOnce(
            Response.json({ ok: true, endpointRuntimeStatus: { status: "configured" } }),
          );
        vi.stubGlobal("fetch", fetchMock);

        yield* withCloudServices(
          linkPrimaryEnvironmentToCloud({
            clerkToken: "clerk-token",
          }),
        );

        expect(getRelayClientStatusMock).toHaveBeenCalledOnce();
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
          "https://relay.example.test/v1/client/environment-link-challenges",
        );
        expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
        expect(fetchMock.mock.calls[0]?.[1]?.headers.authorization).toBe("Bearer clerk-token");
        expect(fetchMock.mock.calls[0]?.[1]?.credentials).not.toBe("include");

        expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
          "http://127.0.0.1:3000/api/connect/link-proof",
        );
        expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
          method: "POST",
          credentials: "include",
          headers: expect.objectContaining({
            "content-type": "application/json",
          }),
        });
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        expect(JSON.parse(requestBodyText(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
          challenge: "link-challenge",
          endpoint: {
            httpBaseUrl: "http://127.0.0.1:3000",
            wsBaseUrl: "ws://127.0.0.1:3000",
            providerKind: "cloudflare_tunnel",
          },
          origin: {
            localHttpHost: "127.0.0.1",
            localHttpPort: 3000,
          },
        });

        expect(String(fetchMock.mock.calls[2]?.[0])).toBe(
          "https://relay.example.test/v1/client/environment-links",
        );
        expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("POST");
        expect(fetchMock.mock.calls[2]?.[1]?.headers.authorization).toBe("Bearer clerk-token");
        expect(fetchMock.mock.calls[2]?.[1]?.credentials).not.toBe("include");
        expect(fetchMock.mock.calls[2]?.[1]?.headers["content-type"]).toBe("application/json");
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        expect(JSON.parse(requestBodyText(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
          proof: validProof(),
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled: true,
        });

        expect(String(fetchMock.mock.calls[3]?.[0])).toBe(
          "http://127.0.0.1:3000/api/connect/relay-config",
        );
        expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
          method: "POST",
          credentials: "include",
          headers: expect.objectContaining({
            "content-type": "application/json",
          }),
        });
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        expect(JSON.parse(requestBodyText(fetchMock.mock.calls[3]?.[1]?.body))).toMatchObject({
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://issuer.example.test",
          cloudUserId: "user_123",
          environmentCredential: "t3env_test_credential",
          cloudMintPublicKey: "cloud-mint-public-key",
          endpointRuntime: {
            providerKind: "cloudflare_tunnel",
            connectorToken: "connector-token",
            tunnelId: "tunnel-id",
            tunnelName: "tunnel-name",
          },
        });
      }),
  );

  it.effect("reads the primary local cloud link state with the owner cookie session", () =>
    Effect.gen(function* () {
      vi.mocked(readPrimaryEnvironmentDescriptor).mockReturnValue({
        environmentId: EnvironmentId.make("env-1"),
        label: "Desktop",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      });
      vi.mocked(readPrimaryEnvironmentTarget).mockReturnValue({
        source: "desktop-managed",
        target: {
          httpBaseUrl: "http://127.0.0.1:3000",
          wsBaseUrl: "ws://127.0.0.1:3000",
        },
      });
      const fetchMock = vi.fn().mockResolvedValueOnce(
        Response.json({
          linked: true,
          cloudUserId: "user_123",
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://issuer.example.test",
          publishAgentActivity: false,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const state = yield* withCloudServices(readPrimaryCloudLinkState());
      expect(state).toEqual({
        linked: true,
        cloudUserId: "user_123",
        relayUrl: "https://relay.example.test",
        relayIssuer: "https://issuer.example.test",
        publishAgentActivity: false,
      });
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "http://127.0.0.1:3000/api/connect/link-state",
      );
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        method: "GET",
        credentials: "include",
      });
    }),
  );

  it.effect("clears local relay credentials before revoking the primary cloud link", () =>
    Effect.gen(function* () {
      vi.mocked(readPrimaryEnvironmentDescriptor).mockReturnValue({
        environmentId: EnvironmentId.make("env-1"),
        label: "Desktop",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      });
      vi.mocked(readPrimaryEnvironmentTarget).mockReturnValue({
        source: "desktop-managed",
        target: {
          httpBaseUrl: "http://127.0.0.1:3000",
          wsBaseUrl: "ws://127.0.0.1:3000",
        },
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "disabled" } }),
        )
        .mockResolvedValueOnce(Response.json({ ok: true }));
      vi.stubGlobal("fetch", fetchMock);

      yield* withCloudServices(
        unlinkPrimaryEnvironmentFromCloud({
          clerkToken: "clerk-token",
        }),
      );

      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:3000/api/connect/unlink");
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        method: "POST",
        credentials: "include",
      });
      expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
        "https://relay.example.test/v1/client/environment-links/env-1",
      );
      expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("DELETE");
      expect(fetchMock.mock.calls[1]?.[1]?.headers.authorization).toBe("Bearer clerk-token");
    }),
  );

  it.effect("still clears local relay credentials when relay revocation fails", () =>
    Effect.gen(function* () {
      vi.mocked(readPrimaryEnvironmentDescriptor).mockReturnValue({
        environmentId: EnvironmentId.make("env-1"),
        label: "Desktop",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      });
      vi.mocked(readPrimaryEnvironmentTarget).mockReturnValue({
        source: "desktop-managed",
        target: {
          httpBaseUrl: "http://127.0.0.1:3000",
          wsBaseUrl: "ws://127.0.0.1:3000",
        },
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "disabled" } }),
        )
        .mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }));
      vi.stubGlobal("fetch", fetchMock);

      yield* withCloudServices(
        unlinkPrimaryEnvironmentFromCloud({
          clerkToken: "clerk-token",
        }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:3000/api/connect/unlink");
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        method: "POST",
        credentials: "include",
      });
    }),
  );

  it.effect("rejects primary environment linking when the local environment is not ready", () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", vi.fn());

      const error = yield* withCloudServices(
        linkPrimaryEnvironmentToCloud({
          clerkToken: "clerk-token",
        }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CloudEnvironmentLinkError",
        message: "Local environment is not ready yet.",
      });
      expect(fetch).not.toHaveBeenCalled();
    }),
  );

  it.effect("preserves relay transport failures while linking environments", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(Response.json(validChallenge()))
          .mockResolvedValueOnce(Response.json(validProof()))
          .mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 })),
      );

      const error = yield* withCloudServices(
        linkEnvironmentToCloud({
          environment: savedEnvironment,
          clerkToken: "clerk-token",
        }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CloudEnvironmentLinkError",
        message: "https://relay.example.test/v1/client/environment-links failed",
      });
    }),
  );

  it.effect("preserves typed relay error bodies while linking environments", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(Response.json(validChallenge()))
          .mockResolvedValueOnce(Response.json(validProof()))
          .mockResolvedValueOnce(
            Response.json(
              {
                _tag: "RelayEnvironmentLinkProofInvalidError",
                code: "environment_link_proof_invalid",
                reason: "origin_not_allowed",
                traceId: "trace-test",
              },
              { status: 400 },
            ),
          ),
      );

      const error = yield* withCloudServices(
        linkEnvironmentToCloud({
          environment: savedEnvironment,
          clerkToken: "clerk-token",
        }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CloudEnvironmentLinkError",
        message:
          "https://relay.example.test/v1/client/environment-links failed: Relay rejected the environment link proof (origin_not_allowed).",
      });
    }),
  );

  it.effect("rejects relay credentials for a different environment", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(Response.json(validChallenge()))
        .mockResolvedValueOnce(Response.json(validProof()))
        .mockResolvedValueOnce(
          Response.json({
            ok: true,
            environmentId: "env-2",
            endpoint: {
              httpBaseUrl: "https://desktop.example.test",
              wsBaseUrl: "wss://desktop.example.test",
              providerKind: "cloudflare_tunnel",
            },
            endpointRuntime: null,
            relayIssuer: "https://issuer.example.test",
            cloudUserId: "user_123",
            environmentCredential: "t3env_test_credential",
            cloudMintPublicKey: "cloud-mint-public-key",
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const error = yield* withCloudServices(
        linkEnvironmentToCloud({
          environment: savedEnvironment,
          clerkToken: "clerk-token",
        }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CloudEnvironmentLinkError",
        message: "Relay returned credentials for a different environment.",
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }),
  );

  it.effect("rejects relay credentials for a different managed endpoint provider", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(Response.json(validChallenge()))
        .mockResolvedValueOnce(Response.json(validProof()))
        .mockResolvedValueOnce(
          Response.json({
            ok: true,
            environmentId: "env-1",
            endpoint: {
              httpBaseUrl: "https://desktop.example.test",
              wsBaseUrl: "wss://desktop.example.test",
              providerKind: "manual",
            },
            endpointRuntime: null,
            relayIssuer: "https://issuer.example.test",
            cloudUserId: "user_123",
            environmentCredential: "t3env_test_credential",
            cloudMintPublicKey: "cloud-mint-public-key",
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const error = yield* withCloudServices(
        linkEnvironmentToCloud({
          environment: savedEnvironment,
          clerkToken: "clerk-token",
        }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "CloudEnvironmentLinkError",
        message: "Relay returned credentials for a different endpoint provider.",
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }),
  );

  it.effect("passes the relay issuer from the link response into local relay config", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(Response.json(validChallenge()))
        .mockResolvedValueOnce(Response.json(validProof()))
        .mockResolvedValueOnce(
          Response.json({
            ok: true,
            environmentId: "env-1",
            endpoint: {
              httpBaseUrl: "https://desktop.example.test",
              wsBaseUrl: "wss://desktop.example.test",
              providerKind: "cloudflare_tunnel",
            },
            endpointRuntime: null,
            relayIssuer: "https://issuer.example.test",
            cloudUserId: "user_123",
            environmentCredential: "t3env_test_credential",
            cloudMintPublicKey: "cloud-mint-public-key",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "disabled" } }),
        );
      vi.stubGlobal("fetch", fetchMock);

      yield* withCloudServices(
        linkEnvironmentToCloud({
          environment: savedEnvironment,
          clerkToken: "clerk-token",
        }),
      );

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(requestBodyText(fetchMock.mock.calls[3]?.[1]?.body))).toMatchObject({
        relayUrl: "https://relay.example.test",
        relayIssuer: "https://issuer.example.test",
        cloudUserId: "user_123",
      });
    }),
  );
});
