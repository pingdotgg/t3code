import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import type { ServerConfigShape } from "../../config.ts";
import { ServerConfig } from "../../config.ts";
import { BootstrapCredentialServiceLive } from "./BootstrapCredentialService.ts";
import { ServerSecretStoreLive } from "./ServerSecretStore.ts";
import { SessionCredentialServiceLive } from "./SessionCredentialService.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AuthControlPlane } from "../Services/AuthControlPlane.ts";
import { makeAuthControlPlane } from "./AuthControlPlane.ts";
import { SessionCredentialService } from "../Services/SessionCredentialService.ts";

const makeServerConfigLayer = (
  overrides?: Partial<Pick<ServerConfigShape, "desktopBootstrapToken">>,
) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfigShape;
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-control-plane-test-" })),
  );

const makeAuthControlPlaneLayer = (
  overrides?: Partial<Pick<ServerConfigShape, "desktopBootstrapToken">>,
) =>
  Layer.effect(AuthControlPlane, makeAuthControlPlane).pipe(
    Layer.provideMerge(BootstrapCredentialServiceLive),
    Layer.provideMerge(SessionCredentialServiceLive),
    Layer.provideMerge(ServerSecretStoreLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(makeServerConfigLayer(overrides)),
  );

it.layer(NodeServices.layer)("AuthControlPlane", (it) => {
  it.effect("creates, lists, and revokes client pairing links", () =>
    Effect.gen(function* () {
      const authControlPlane = yield* AuthControlPlane;

      const created = yield* authControlPlane.createPairingLink({
        role: "client",
        subject: "one-time-token",
        label: "CI phone",
      });
      const listedBeforeRevoke = yield* authControlPlane.listPairingLinks({ role: "client" });
      const revoked = yield* authControlPlane.revokePairingLink(created.id);
      const listedAfterRevoke = yield* authControlPlane.listPairingLinks({ role: "client" });

      expect(created.role).toBe("client");
      expect(created.credential.length).toBeGreaterThan(0);
      expect(listedBeforeRevoke).toHaveLength(1);
      expect(listedBeforeRevoke[0]?.id).toBe(created.id);
      expect(listedBeforeRevoke[0]?.label).toBe("CI phone");
      expect(listedBeforeRevoke[0]?.credential).toBe(created.credential);
      expect(revoked).toBe(true);
      expect(listedAfterRevoke).toHaveLength(0);
    }).pipe(Effect.provide(makeAuthControlPlaneLayer())),
  );

  it.effect("issues bearer sessions and lists them without exposing raw tokens", () =>
    Effect.gen(function* () {
      const authControlPlane = yield* AuthControlPlane;
      const sessionCredentials = yield* SessionCredentialService;

      const issued = yield* authControlPlane.issueSession({
        label: "deploy-bot",
      });
      const verified = yield* sessionCredentials.verify(issued.token);
      const listedBeforeRevoke = yield* authControlPlane.listSessions();
      const revoked = yield* authControlPlane.revokeSession(issued.sessionId);
      const listedAfterRevoke = yield* authControlPlane.listSessions();

      expect(issued.method).toBe("bearer-session-token");
      expect(issued.role).toBe("owner");
      expect(issued.client.deviceType).toBe("bot");
      expect(issued.client.label).toBe("deploy-bot");
      expect(verified.sessionId).toBe(issued.sessionId);
      expect(verified.role).toBe("owner");
      expect(verified.method).toBe("bearer-session-token");
      expect(listedBeforeRevoke).toHaveLength(1);
      expect(listedBeforeRevoke[0]?.sessionId).toBe(issued.sessionId);
      expect("token" in (listedBeforeRevoke[0] ?? {})).toBe(false);
      expect(revoked).toBe(true);
      expect(listedAfterRevoke).toHaveLength(0);
    }).pipe(Effect.provide(makeAuthControlPlaneLayer())),
  );

  it.effect("surfaces lastConnectedAt through the listed session view", () =>
    Effect.gen(function* () {
      const authControlPlane = yield* AuthControlPlane;
      const sessionCredentials = yield* SessionCredentialService;

      const issued = yield* authControlPlane.issueSession({
        label: "remote-ipad",
      });
      const beforeConnect = yield* authControlPlane.listSessions();
      yield* sessionCredentials.markConnected(issued.sessionId);
      const afterConnect = yield* authControlPlane.listSessions();

      expect(beforeConnect[0]?.lastConnectedAt).toBeNull();
      expect(afterConnect[0]?.lastConnectedAt).not.toBeNull();
    }).pipe(Effect.provide(makeAuthControlPlaneLayer())),
  );
});
