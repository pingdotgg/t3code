import { describe, expect } from "vite-plus/test";
import {
  ProviderInstanceId,
  type HermesGatewayCompatibility,
  type HermesGatewaySessionListResult,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeHermesSessionCatalog } from "./HermesSessionCatalog.ts";
import { HermesServeRuntimeError } from "./HermesServeRuntime.ts";

const supportedCompatibility: HermesGatewayCompatibility = {
  status: "supported",
  protocol: { major: 1, minor: 0 },
  capabilities: ["profile.import", "session.lifecycle"],
  inventory: ["profile.import", "session.lifecycle"],
  reason: "complete negotiation",
};

const makeFakeClient = (compatibility: HermesGatewayCompatibility) => {
  const calls: string[] = [];
  return {
    calls,
    client: {
      connect: async () => {
        calls.push("connect");
        return compatibility;
      },
      listSessions: async (): Promise<HermesGatewaySessionListResult> => {
        calls.push("listSessions");
        return { sessions: [] };
      },
      close: () => {
        calls.push("close");
      },
    },
  };
};

const catalogInput = {
  providerInstanceId: ProviderInstanceId.make("hermes-test"),
  endpoint: "ws://127.0.0.1:18789",
  authToken: "gateway-token",
  remoteGloballyEnabled: true,
  remoteInstanceEnabled: true,
  remotePairingToken: undefined,
  remoteTlsCertificateSha256: undefined,
  profileKey: "main",
  importEnabled: true,
} as const;

describe("HermesSessionCatalog", () => {
  effectIt.effect(
    "refuses to connect to a non-loopback endpoint when remote access is disabled",
    () =>
      Effect.gen(function* () {
        const fake = makeFakeClient(supportedCompatibility);
        const catalog = makeHermesSessionCatalog({
          ...catalogInput,
          endpoint: "wss://hermes.example.com:18789",
          remoteInstanceEnabled: false,
          clientFactory: () => fake.client,
        });
        const error = yield* Effect.flip(catalog.list(10));
        expect(error.code).toBe("provider_not_configured");
        expect(error.message).toBe(
          "Hermes session discovery is blocked by the gateway connection policy.",
        );
        expect(error.cause).toMatchObject({
          status: "blocked",
          code: "remote_instance_disabled",
        });
        expect(fake.calls).toEqual([]);
      }),
  );

  effectIt.effect("refuses a remote endpoint even when remote access is enabled", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient(supportedCompatibility);
      const catalog = makeHermesSessionCatalog({
        ...catalogInput,
        endpoint: "wss://hermes.example.com:18789",
        clientFactory: () => fake.client,
      });
      const error = yield* Effect.flip(catalog.list(10));
      expect(error.code).toBe("provider_not_configured");
      expect(fake.calls).toEqual([]);
    }),
  );

  effectIt.effect("rejects gateways that do not advertise profile.import before listing", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient({
        ...supportedCompatibility,
        capabilities: ["session.lifecycle"],
        inventory: ["session.lifecycle"],
      });
      const catalog = makeHermesSessionCatalog({
        ...catalogInput,
        clientFactory: () => fake.client,
      });
      const error = yield* Effect.flip(catalog.list(10));
      expect(error.code).toBe("import_failed");
      expect(error.message).toContain("profile.import");
      expect(fake.calls).toEqual(["connect", "close"]);
    }),
  );

  effectIt.effect("rejects legacy gateways without a negotiated inventory before listing", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient({
        status: "legacy",
        protocol: null,
        capabilities: [],
        inventory: null,
        reason: "no negotiation",
      });
      const catalog = makeHermesSessionCatalog({
        ...catalogInput,
        clientFactory: () => fake.client,
      });
      const error = yield* Effect.flip(catalog.list(10));
      expect(error.code).toBe("import_failed");
      expect(error.message).toContain("evidence-backed");
      expect(fake.calls).toEqual(["connect", "close"]);
    }),
  );

  effectIt.effect("starts the managed serve runtime before discovery when provided", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient(supportedCompatibility);
      const order: string[] = [];
      const catalog = makeHermesSessionCatalog({
        ...catalogInput,
        ensureReady: Effect.sync(() => {
          order.push("ensure-ready");
          return {
            endpoint: catalogInput.endpoint,
            authToken: catalogInput.authToken,
            ownership: "t3_owned" as const,
          };
        }),
        clientFactory: (options) => {
          order.push(`client:${options.endpoint}`);
          return fake.client;
        },
      });
      const snapshot = yield* catalog.list(10);
      expect(snapshot.sessions).toEqual([]);
      expect(order).toEqual(["ensure-ready", `client:${catalogInput.endpoint}/`]);
    }),
  );

  effectIt.effect("surfaces managed startup failures as gateway errors", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient(supportedCompatibility);
      const catalog = makeHermesSessionCatalog({
        ...catalogInput,
        ensureReady: Effect.fail(
          new HermesServeRuntimeError({
            code: "managed_start_failed",
            message: "T3 could not launch `hermes serve`.",
          }),
        ),
        clientFactory: () => fake.client,
      });
      const error = yield* Effect.flip(catalog.list(10));
      expect(error.code).toBe("gateway_error");
      expect(error.message).toContain("hermes serve");
      expect(fake.calls).toEqual([]);
    }),
  );

  effectIt.effect("lists sessions from a ready loopback gateway with negotiated import", () =>
    Effect.gen(function* () {
      const fake = makeFakeClient(supportedCompatibility);
      const catalog = makeHermesSessionCatalog({
        ...catalogInput,
        clientFactory: () => fake.client,
      });
      const snapshot = yield* catalog.list(10);
      expect(snapshot.profileKey).toBe("main");
      expect(snapshot.sessions).toEqual([]);
      expect(fake.calls).toEqual(["connect", "listSessions", "close"]);
    }),
  );
});
