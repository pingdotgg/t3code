import {
  type DesktopBridge,
  EnvironmentId,
  type RelayClientInstallProgressEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/unstable/http";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentSupervisor,
  type PreparedConnection,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { type RpcSession } from "@t3tools/client-runtime/rpc";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { __resetDesktopPrimaryAuthForTests } from "../environments/primary/desktopAuth";

import {
  CloudEnvironmentLinkOperationError,
  collectCloudLinkTargets,
  isCloudEnvironmentLinkError,
  linkPrimaryEnvironmentToCloud,
  listManagedCloudEnvironments,
  normalizeRelayBaseUrl,
  readPrimaryCloudLinkState,
  type CloudLinkTarget,
  unlinkPrimaryEnvironmentFromCloud,
} from "./linkEnvironment";

const TARGET: CloudLinkTarget = {
  environmentId: "environment-1",
  label: "Desktop",
  httpBaseUrl: "http://127.0.0.1:3000",
  wsBaseUrl: "ws://127.0.0.1:3000",
};

const relayClientInstallDialog = vi.hoisted(() => ({
  requestConfirmation: vi.fn(),
  reportProgress: vi.fn(),
  finish: vi.fn(),
}));

const cloudPublicConfig = vi.hoisted(() => ({
  relayUrl: "https://relay.example.test",
}));

vi.mock("./relayClientInstallDialog", () => ({
  requestRelayClientInstallConfirmation: relayClientInstallDialog.requestConfirmation,
  reportRelayClientInstallProgress: relayClientInstallDialog.reportProgress,
  finishRelayClientInstall: relayClientInstallDialog.finish,
}));

vi.mock("./publicConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./publicConfig")>()),
  resolveCloudPublicConfig: () => ({ relayUrl: cloudPublicConfig.relayUrl }),
}));

const createProof = vi.fn(() => Effect.succeed("dpop-proof"));
const dpopSignerLayer = Layer.succeed(
  ManagedRelay.ManagedRelayDpopSigner,
  ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("thumbprint"),
    createProof,
  }),
);

function relayLayer() {
  const http = remoteHttpClientLayer(globalThis.fetch);
  return Layer.mergeAll(
    http,
    ManagedRelay.layer({
      relayUrl: "https://relay.example.test",
      clientId: RelayWebClientId,
    }).pipe(Layer.provideMerge(dpopSignerLayer), Layer.provide(http)),
  );
}

function registryLayer(options?: {
  readonly status?: { readonly status: "available"; readonly version: string };
  readonly installEvents?: ReadonlyArray<RelayClientInstallProgressEvent>;
}) {
  return Layer.effect(
    EnvironmentRegistry,
    Effect.gen(function* () {
      const client = {
        [WS_METHODS.cloudGetRelayClientStatus]: () =>
          Effect.succeed(options?.status ?? { status: "available", version: "2026.6.0" }),
        [WS_METHODS.cloudInstallRelayClient]: () =>
          Stream.fromIterable(options?.installEvents ?? []),
      } as unknown as RpcSession["client"];
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make(TARGET.environmentId),
        label: TARGET.label,
        httpBaseUrl: TARGET.httpBaseUrl,
        wsBaseUrl: TARGET.wsBaseUrl,
      });
      const supervisor = EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor["Service"]);
      const registry = {
        run: <A, E, R>(_environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) =>
          Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        runStream: <A, E, R>(_environmentId: EnvironmentId, stream: Stream.Stream<A, E, R>) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      } as unknown as EnvironmentRegistry["Service"];
      return EnvironmentRegistry.of(registry);
    }),
  );
}

function services(options?: Parameters<typeof registryLayer>[0]) {
  return Layer.mergeAll(relayLayer(), registryLayer(options));
}

function withServices<A, E>(
  effect: Effect.Effect<
    A,
    E,
    HttpClient.HttpClient | ManagedRelay.ManagedRelayClient | EnvironmentRegistry
  >,
  options?: Parameters<typeof registryLayer>[0],
) {
  return effect.pipe(Effect.provide(services(options)));
}

function bodyText(body: BodyInit | null | undefined): string {
  return body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  cloudPublicConfig.relayUrl = "https://relay.example.test";
  vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
  relayClientInstallDialog.requestConfirmation.mockResolvedValue(true);
});

afterEach(() => {
  __resetDesktopPrimaryAuthForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("web cloud link environment client", () => {
  it("normalizes relay URLs and de-duplicates cloud link targets", () => {
    expect(normalizeRelayBaseUrl(" https://relay.example.test/// ")).toBe(
      "https://relay.example.test",
    );
    expect(normalizeRelayBaseUrl(" ")).toBeNull();
    expect(
      collectCloudLinkTargets({
        primary: TARGET,
        saved: [TARGET, { ...TARGET, environmentId: "environment-2" }],
      }).map((target) => target.environmentId),
    ).toEqual(["environment-1", "environment-2"]);
  });

  it.effect("lists relay-managed environments through the typed relay client", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          environments: [
            {
              environmentId: "environment-1",
              label: "Desktop",
              endpoint: {
                httpBaseUrl: "https://desktop.example.test",
                wsBaseUrl: "wss://desktop.example.test",
                providerKind: "cloudflare_tunnel",
              },
              linkedAt: "2026-06-06T00:00:00.000Z",
            },
          ],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const environments = yield* withServices(
        listManagedCloudEnvironments({ clerkToken: "clerk-token" }),
      );

      expect(environments).toHaveLength(1);
      expect(fetchMock.mock.calls[0]?.[1]?.headers.authorization).toBe("Bearer clerk-token");
    }),
  );

  it.effect("preserves structured relay failures and trace IDs", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          Response.json(
            {
              _tag: "RelayAuthInvalidError",
              code: "auth_invalid",
              reason: "invalid_bearer",
              traceId: "trace-web-cloud-link",
            },
            { status: 401 },
          ),
        ),
      );

      const error = yield* withServices(
        listManagedCloudEnvironments({ clerkToken: "clerk-token" }),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(CloudEnvironmentLinkOperationError);
      expect(error).toMatchObject({
        action: "list relay-managed environments",
        relayUrlInputLength: "https://relay.example.test".length,
        relayUrlProtocol: "https:",
        relayUrlHostname: "relay.example.test",
        traceId: "trace-web-cloud-link",
        relayError: {
          _tag: "RelayAuthInvalidError",
          reason: "invalid_bearer",
        },
        cause: {
          _tag: "ManagedRelayRequestFailedError",
        },
      });
      expect(error.message).toBe("Could not list relay-managed environments.");
      expect(isCloudEnvironmentLinkError(error)).toBe(true);
    }),
  );

  it.effect("reads primary cloud link state from the explicit target", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          linked: true,
          cloudUserId: "user-1",
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          publishAgentActivity: false,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const state = yield* withServices(readPrimaryCloudLinkState({ target: TARGET }));

      expect(Option.fromNullishOr(state)).toEqual(
        Option.some({
          linked: true,
          cloudUserId: "user-1",
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          publishAgentActivity: false,
        }),
      );
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "http://127.0.0.1:3000/api/connect/link-state",
      );
    }),
  );

  it.effect("preserves structured environment API failures and their cause chain", () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          Response.json(
            {
              _tag: "EnvironmentHttpUnauthorizedError",
              message: "Environment bearer token is invalid.",
            },
            { status: 401 },
          ),
        ),
      );

      const error = yield* withServices(readPrimaryCloudLinkState({ target: TARGET })).pipe(
        Effect.flip,
      );

      expect(error).toBeInstanceOf(CloudEnvironmentLinkOperationError);
      expect(error).toMatchObject({
        action: "read environment cloud link state",
        environmentId: TARGET.environmentId,
        httpBaseUrlInputLength: TARGET.httpBaseUrl.length,
        httpBaseUrlProtocol: "http:",
        httpBaseUrlHostname: "127.0.0.1",
        environmentError: {
          _tag: "EnvironmentHttpUnauthorizedError",
          message: "Environment bearer token is invalid.",
        },
      });
      expect(error.cause).toBeDefined();
      expect(error.message).toBe(
        `Could not read environment cloud link state for environment "${TARGET.environmentId}".`,
      );
      expect(isCloudEnvironmentLinkError(error)).toBe(true);
    }),
  );

  it.effect("preserves invalid environment HTTP URL parser causes", () =>
    Effect.gen(function* () {
      const invalidUrl =
        "https://user:password@[invalid-host]/private/path?access_token=secret#fragment";
      const error = yield* withServices(
        readPrimaryCloudLinkState({
          target: {
            ...TARGET,
            httpBaseUrl: invalidUrl,
          },
        }),
      ).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "CloudEnvironmentLinkOperationError",
        action: "initialize the environment HTTP client",
        environmentId: TARGET.environmentId,
        httpBaseUrlInputLength: invalidUrl.length,
      });
      expect(error.cause).toBeInstanceOf(TypeError);
      expect(error).not.toHaveProperty("httpBaseUrl");
      expect(error).not.toHaveProperty("httpBaseUrlProtocol");
      expect(error).not.toHaveProperty("httpBaseUrlHostname");
      expect(error.message).not.toMatch(/user|password|private|path|access_token|secret|fragment/);
    }),
  );

  it("keeps environment endpoint secrets out of mapped error attributes", () => {
    const httpBaseUrl =
      "https://user:password@environment.example.test/private/path?access_token=secret#fragment";
    const cause = new Error("request failed");
    const error = CloudEnvironmentLinkOperationError.fromEnvironmentApi({
      action: "read environment cloud link state",
      environmentId: TARGET.environmentId,
      httpBaseUrl,
      cause,
    });

    expect(error).toMatchObject({
      httpBaseUrlInputLength: httpBaseUrl.length,
      httpBaseUrlProtocol: "https:",
      httpBaseUrlHostname: "environment.example.test",
      cause,
    });
    expect(error.cause).toBe(cause);
    expect(error).not.toHaveProperty("httpBaseUrl");
    const diagnostics = JSON.stringify(error);
    expect(diagnostics).not.toMatch(/user|password|private|path|access_token|secret|fragment/);
    expect(error.message).not.toMatch(/user|password|private|path|access_token|secret|fragment/);
  });

  it.effect("uses desktop bearer auth for primary cloud link state", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          linked: true,
          cloudUserId: "user-1",
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          publishAgentActivity: false,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("window", {
        location: { origin: "t3code://app" },
        desktopBridge: {
          getLocalEnvironmentBearerToken: vi.fn().mockResolvedValue("desktop-bearer-token"),
        } as unknown as DesktopBridge,
      });

      yield* withServices(readPrimaryCloudLinkState({ target: TARGET }));

      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).not.toBe("include");
      expect(request.headers.get("authorization")).toBe("Bearer desktop-bearer-token");
    }),
  );

  it.effect("links an available primary environment without invoking installation", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            challenge: "challenge",
            expiresAt: "2026-06-06T00:05:00.000Z",
          }),
        )
        .mockResolvedValueOnce(Response.json("signed-proof"))
        .mockResolvedValueOnce(
          Response.json({
            ok: true,
            environmentId: TARGET.environmentId,
            endpoint: {
              httpBaseUrl: "https://desktop.example.test",
              wsBaseUrl: "wss://desktop.example.test",
              providerKind: "cloudflare_tunnel",
            },
            endpointRuntime: null,
            relayIssuer: "https://relay.example.test",
            cloudUserId: "user-1",
            environmentCredential: "environment-credential",
            cloudMintPublicKey: "public-key",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "configured" } }),
        );
      vi.stubGlobal("fetch", fetchMock);

      yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: TARGET,
          clerkToken: "clerk-token",
        }),
      );

      expect(relayClientInstallDialog.requestConfirmation).not.toHaveBeenCalled();
      expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
        "http://127.0.0.1:3000/api/connect/link-proof",
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(bodyText(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
        challenge: "challenge",
        endpoint: {
          httpBaseUrl: TARGET.httpBaseUrl,
          wsBaseUrl: TARGET.wsBaseUrl,
        },
      });
    }),
  );

  it.effect("installs a missing relay client before linking", () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ malformed: true })));

      yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: TARGET,
          clerkToken: "clerk-token",
        }),
        {
          status: { status: "available", version: "2026.6.0" },
          installEvents: [],
        },
      ).pipe(Effect.flip);

      expect(relayClientInstallDialog.requestConfirmation).not.toHaveBeenCalled();
    }),
  );

  it.effect("unlinks locally before revoking the relay record", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "disabled" } }),
        )
        .mockResolvedValueOnce(Response.json({ ok: true }));
      vi.stubGlobal("fetch", fetchMock);

      yield* withServices(
        unlinkPrimaryEnvironmentFromCloud({
          target: TARGET,
          clerkToken: "clerk-token",
        }),
      );

      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:3000/api/connect/unlink");
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
        `/v1/client/environment-links/${TARGET.environmentId}`,
      );
    }),
  );

  it.effect("keeps configured relay URL secrets out of revoke warnings", () => {
    const relayUrl =
      "https://relay-user:relay-password@relay.example.test/private/workspace?access_token=relay-secret#relay-fragment";
    cloudPublicConfig.relayUrl = relayUrl;
    const capturedLogs: Array<ReadonlyArray<unknown>> = [];
    const logger = Logger.make(({ message }) => {
      capturedLogs.push(Array.isArray(message) ? message : [message]);
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ ok: true, endpointRuntimeStatus: { status: "disabled" } }),
      )
      .mockResolvedValueOnce(Response.json({ malformed: true }, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    return unlinkPrimaryEnvironmentFromCloud({
      target: TARGET,
      clerkToken: "clerk-token",
    }).pipe(
      Effect.provide(
        Layer.merge(
          services(),
          Logger.layer([logger], {
            mergeWithExisting: false,
          }),
        ),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(capturedLogs).toHaveLength(1);
          const logFields = capturedLogs[0]?.find(
            (value): value is Record<string, unknown> =>
              typeof value === "object" && value !== null,
          );
          expect(logFields).toMatchObject({
            relayUrlInputLength: relayUrl.length,
            relayUrlProtocol: "https:",
            relayUrlHostname: "relay.example.test",
          });
          expect(logFields).not.toHaveProperty("relayUrl");
          const logText = [
            ...(capturedLogs[0]?.filter((value): value is string => typeof value === "string") ??
              []),
            String(logFields?.cause),
          ].join(" ");
          for (const secret of [
            "relay-user",
            "relay-password",
            "/private/workspace",
            "access_token=relay-secret",
            "relay-fragment",
          ]) {
            expect(logText).not.toContain(secret);
          }
        }),
      ),
    );
  });
});
