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
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import {
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  PrimaryConnectionTarget,
  EnvironmentSupervisor,
} from "@t3tools/client-runtime/connection";
import { type RpcSession } from "@t3tools/client-runtime/rpc";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { __resetDesktopPrimaryAuthForTests } from "../environments/primary/desktopAuth";

import { readPrimaryCloudLinkState, type CloudLinkTarget } from "./linkEnvironment";

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
        subscribeServerConfig: (input) => client.subscribeServerConfig(input),
        ready: Effect.void,
        probe: Effect.void,
        inboundFrames: Effect.succeed(0),
        closed: Effect.never,
      };
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make(TARGET.environmentId),
        label: TARGET.label,
        httpBaseUrl: TARGET.httpBaseUrl,
        wsBaseUrl: TARGET.wsBaseUrl,
      });
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const registry = {
        run: <A, E, R>(_environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        runStream: <A, E, R>(_environmentId: EnvironmentId, stream: Stream.Stream<A, E, R>) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
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
  it.effect("uses desktop bearer auth for primary cloud link state", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValue(
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

      yield* withServices(readPrimaryCloudLinkState({ target: TARGET }));

      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).not.toBe("include");
      expect(request.headers.get("authorization")).toBe("Bearer desktop-bearer-token");
    }),
  );
});
