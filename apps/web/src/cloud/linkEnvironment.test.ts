import {
  type DesktopBridge,
  EnvironmentId,
  type RelayClientInstallProgressEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import {
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  EnvironmentSupervisor,
} from "@t3tools/client-runtime/connection";
import { type RpcSession } from "@t3tools/client-runtime/rpc";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { __resetDesktopPrimaryAuthForTests } from "../environments/primary/desktopAuth";

import { readCloudLinkState, unlinkEnvironmentFromCloud } from "./linkEnvironment";

const TARGET = {
  environmentId: "environment-1",
  label: "Desktop",
  httpBaseUrl: "http://127.0.0.1:3000",
  wsBaseUrl: "ws://127.0.0.1:3000",
};

const SAVED_SERVICE_TARGET = {
  environmentId: "saved-service",
  label: "Service",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
};

const relayClientInstallDialog = vi.hoisted(() => ({
  requestConfirmation: vi.fn(),
  reportProgress: vi.fn(),
  finish: vi.fn(),
}));

vi.mock("./relayClientInstallDialog", () => ({
  requestRelayClientInstallConfirmation: relayClientInstallDialog.requestConfirmation,
  reportRelayClientInstallProgress: relayClientInstallDialog.reportProgress,
  finishRelayClientInstall: relayClientInstallDialog.finish,
}));

const createProof = vi.fn(() => Effect.succeed("dpop-proof"));
const layerDpopSigner = Layer.succeed(
  ManagedRelay.ManagedRelayDpopSigner,
  ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("thumbprint"),
    createProof,
  }),
);

function layerRelay() {
  const layerHttp = layerRemoteHttpClient(globalThis.fetch);
  return Layer.mergeAll(
    layerHttp,
    ManagedRelay.layer({
      relayUrl: "https://relay.example.test",
      clientId: RelayWebClientId,
    }).pipe(Layer.provideMerge(layerDpopSigner), Layer.provide(layerHttp)),
  );
}

function layerRegistry(options?: {
  readonly status?: { readonly status: "available"; readonly version: string };
  readonly installEvents?: ReadonlyArray<RelayClientInstallProgressEvent>;
}) {
  return Layer.effect(
    EnvironmentRegistry.EnvironmentRegistry,
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
        subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
        ready: Effect.void,
        probe: Effect.void,
        inboundFrames: Effect.succeed(0),
        closed: Effect.never,
      };
      const makeSupervisor = Effect.fn(function* (prepared: Option.Option<PreparedConnection>) {
        return EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: new PrimaryConnectionTarget({
            environmentId: EnvironmentId.make(TARGET.environmentId),
            label: TARGET.label,
            httpBaseUrl: TARGET.httpBaseUrl,
            wsBaseUrl: TARGET.wsBaseUrl,
          }),
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.some(session)),
          prepared: yield* SubscriptionRef.make(prepared),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      });
      const supervisors = new Map([
        [
          TARGET.environmentId,
          yield* makeSupervisor(
            Option.some({
              environmentId: EnvironmentId.make(TARGET.environmentId),
              label: TARGET.label,
              httpBaseUrl: TARGET.httpBaseUrl,
              socketUrl: `${TARGET.wsBaseUrl}/ws`,
              httpAuthorization: { _tag: "Bearer", token: "desktop-bearer-token" },
              target: new PrimaryConnectionTarget({
                environmentId: EnvironmentId.make(TARGET.environmentId),
                label: TARGET.label,
                httpBaseUrl: TARGET.httpBaseUrl,
                wsBaseUrl: TARGET.wsBaseUrl,
              }),
            }),
          ),
        ],
        [
          SAVED_SERVICE_TARGET.environmentId,
          yield* makeSupervisor(
            Option.some({
              environmentId: EnvironmentId.make(SAVED_SERVICE_TARGET.environmentId),
              label: SAVED_SERVICE_TARGET.label,
              httpBaseUrl: SAVED_SERVICE_TARGET.httpBaseUrl,
              socketUrl: `${SAVED_SERVICE_TARGET.wsBaseUrl}/ws`,
              httpAuthorization: { _tag: "Bearer", token: "saved-service-token" },
              target: new BearerConnectionTarget({
                environmentId: EnvironmentId.make(SAVED_SERVICE_TARGET.environmentId),
                label: SAVED_SERVICE_TARGET.label,
                connectionId: "saved-service-connection",
              }),
            }),
          ),
        ],
      ]);
      const supervisorFor = (environmentId: EnvironmentId) => supervisors.get(environmentId)!;
      const registry = {
        run: <A, E, R>(environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) =>
          Effect.provideService(
            effect,
            EnvironmentSupervisor.EnvironmentSupervisor,
            supervisorFor(environmentId),
          ),
        runStream: <A, E, R>(environmentId: EnvironmentId, stream: Stream.Stream<A, E, R>) =>
          Stream.provideService(
            stream,
            EnvironmentSupervisor.EnvironmentSupervisor,
            supervisorFor(environmentId),
          ),
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
      return EnvironmentRegistry.EnvironmentRegistry.of(registry);
    }),
  );
}

function layerServices(options?: Parameters<typeof layerRegistry>[0]) {
  return Layer.mergeAll(layerRelay(), layerRegistry(options));
}

function withServices<A, E>(
  effect: Effect.Effect<
    A,
    E,
    | HttpClient.HttpClient
    | ManagedRelay.ManagedRelayClient
    | EnvironmentRegistry.EnvironmentRegistry
  >,
  options?: Parameters<typeof layerRegistry>[0],
) {
  return effect.pipe(Effect.provide(layerServices(options)));
}

beforeEach(() => {
  vi.clearAllMocks();
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
  it.effect("reads link state from the chosen environment with its own credentials", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          linked: true,
          cloudUserId: "user-1",
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          managedTunnelActive: true,
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

      for (const [target, token] of [
        [TARGET, "desktop-bearer-token"],
        [SAVED_SERVICE_TARGET, "saved-service-token"],
      ] as const) {
        fetchMock.mockClear();
        yield* withServices(
          readCloudLinkState({
            target: { environmentId: EnvironmentId.make(target.environmentId) },
          }),
        );

        const [input, init] = fetchMock.mock.calls[0]!;
        const request = new Request(input, init);
        expect(new URL(request.url).origin).toBe(target.httpBaseUrl);
        expect(request.credentials).not.toBe("include");
        expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      }
    }),
  );

  it.effect("reports why the relay kept the environment after a local unlink", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          String(input).startsWith("https://relay.example.test/")
            ? Response.json(
                {
                  _tag: "RelayInternalError",
                  code: "internal_error",
                  reason: "upstream_unavailable",
                  traceId: "trace-unlink",
                },
                { status: 500 },
              )
            : Response.json({ ok: true, endpointRuntimeStatus: null }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("window", {
        location: { origin: "t3code://app" },
        desktopBridge: {
          getLocalEnvironmentBearerToken: vi.fn().mockResolvedValue("desktop-bearer-token"),
        } as unknown as DesktopBridge,
      });

      const error = yield* withServices(
        unlinkEnvironmentFromCloud({
          target: { environmentId: EnvironmentId.make(TARGET.environmentId) },
          clerkToken: "clerk-token",
        }),
      ).pipe(Effect.flip);

      expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
        "http://127.0.0.1:3000/api/connect/unlink",
        "https://relay.example.test/v1/client/environment-links/environment-1",
      ]);
      expect(error).toMatchObject({
        _tag: "CloudEnvironmentLinkError",
        message:
          "Disconnected locally, but T3 Connect did not confirm it removed this environment: Relay encountered an internal error (upstream_unavailable).",
        traceId: "trace-unlink",
      });
    }),
  );

  it.effect("preserves the network hint when relay cleanup fails after local unlink", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn((input: RequestInfo | URL) =>
        String(input).startsWith("https://relay.example.test/")
          ? Promise.reject(new TypeError("Failed to fetch"))
          : Promise.resolve(Response.json({ ok: true, endpointRuntimeStatus: null })),
      );
      vi.stubGlobal("fetch", fetchMock);

      const error = yield* withServices(
        unlinkPrimaryEnvironmentFromCloud({ target: TARGET, clerkToken: "clerk-token" }),
      ).pipe(Effect.flip);

      expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
        "http://127.0.0.1:3000/api/connect/unlink",
        "https://relay.example.test/v1/client/environment-links/environment-1",
      ]);
      expect(error.message).toContain(
        "Disconnected locally, but T3 Connect did not confirm it removed this environment",
      );
      expect(error.message).toContain("Your DNS or firewall may be blocking T3 Connect.");
      expect(error.cause).toMatchObject({
        _tag: "ManagedRelayRequestFailedError",
        transportFailed: true,
      });
    }),
  );

  it.effect("preserves the timeout reason, network hint and trace after local unlink", () =>
    Effect.gen(function* () {
      const relayStarted = yield* Deferred.make<void>();
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        if (String(input).startsWith("https://relay.example.test/")) {
          Deferred.doneUnsafe(relayStarted, Effect.void);
          return new Promise<Response>(() => {});
        }
        return Promise.resolve(Response.json({ ok: true, endpointRuntimeStatus: null }));
      });
      vi.stubGlobal("fetch", fetchMock);

      const unlink = yield* withServices(
        unlinkEnvironmentFromCloud({
          target: { environmentId: EnvironmentId.make(TARGET.environmentId) },
          clerkToken: "clerk-token",
        }),
      ).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(relayStarted);
      yield* TestClock.adjust(ManagedRelay.MANAGED_RELAY_REQUEST_TIMEOUT_MS);
      const error = yield* Fiber.join(unlink);

      expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
        "http://127.0.0.1:3000/api/connect/unlink",
        "https://relay.example.test/v1/client/environment-links/environment-1",
      ]);
      expect(error.message).toContain(
        "Disconnected locally, but T3 Connect did not confirm it removed this environment",
      );
      expect(error.message).toContain("Relay environment unlinking timed out.");
      expect(error.message).toContain("Your DNS or firewall may be blocking T3 Connect.");
      expect(error.traceId).toEqual(expect.any(String));
      expect(error.cause).toMatchObject({
        _tag: "ManagedRelayRequestTimeoutError",
        traceId: error.traceId,
      });
    }),
  );
});
