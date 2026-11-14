// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync or sign.
import * as NodeCrypto from "node:crypto";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { authScopeResponse, AuthStandardClientScopes } from "@t3tools/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

import { TEST_SERVER_PORT, layerServerConfig, layerEnvironmentAuth, makeCookieRequest, makeBearerRequest, requestMetadata, makeDpopKey } from "./EnvironmentAuth-fixtures.testkit.ts";
it.layer(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer))(
  "EnvironmentAuth.layer",
  (it) => {
    it.effect("binds a DPoP session's RPC socket ticket to its proof key", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const key = makeDpopKey();
        const other = makeDpopKey();
        const exchanged = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
          "desktop-bootstrap-token",
          ["orchestration:read"],
          requestMetadata,
          { proofKeyThumbprint: key.thumbprint },
        );
        const session = yield* sessions.verify(exchanged.access_token);
        const host = "192.168.1.50:3773";
        const socketUrl = `http://${host}/ws`;
        const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
        const upgrade = (ticket: string, use: "rpc" | "media", proof?: string) =>
          serverAuth.authenticateWebSocketUpgrade(
            {
              method: "GET",
              url: `/ws?orchestrationProtocol=2&wsTicket=${ticket}${proof ? `&dpop=${proof}` : ""}`,
              cookies: {},
              headers: { host },
            } as never,
            use,
          );

        const rpc = yield* serverAuth.issueWebSocketTicket(session, { use: "rpc" });
        const bare = yield* Effect.flip(upgrade(Redacted.value(rpc.ticket), "rpc"));
        expect(bare._tag).toBe("ServerAuthInvalidCredentialError");
        const signed = yield* upgrade(
          Redacted.value(rpc.ticket),
          "rpc",
          key.sign({ method: "GET", url: socketUrl, token: Redacted.value(rpc.ticket), iat }),
        );
        expect(signed.sessionId).toBe(session.sessionId);

        const wrongKey = yield* Effect.flip(
          upgrade(
            Redacted.value(rpc.ticket),
            "rpc",
            other.sign({ method: "GET", url: socketUrl, token: Redacted.value(rpc.ticket), iat }),
          ),
        );
        expect(wrongKey._tag).toBe("ServerAuthInvalidCredentialError");
        const onMedia = yield* Effect.flip(
          upgrade(
            Redacted.value(rpc.ticket),
            "media",
            key.sign({ method: "GET", url: socketUrl, token: Redacted.value(rpc.ticket), iat }),
          ),
        );
        expect(onMedia._tag).toBe("ServerAuthInvalidCredentialError");

        const media = yield* serverAuth.issueWebSocketTicket(session, { use: "media" });
        expect((yield* upgrade(Redacted.value(media.ticket), "media")).sessionId).toBe(
          session.sessionId,
        );
        const mediaOnRpc = yield* Effect.flip(upgrade(Redacted.value(media.ticket), "rpc"));
        expect(mediaOnRpc._tag).toBe("ServerAuthInvalidCredentialError");

        // Clients that predate ticket binding still connect with the unbound ticket they mint.
        const legacy = yield* serverAuth.issueWebSocketTicket(session);
        expect((yield* upgrade(Redacted.value(legacy.ticket), "rpc")).sessionId).toBe(
          session.sessionId,
        );
      }).pipe(
        Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: "desktop-bootstrap-token" })),
      ),
    );
    it.effect("rejects a replayed proof on a bound RPC socket ticket", () =>
      Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const key = makeDpopKey();
        const exchanged = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
          "desktop-bootstrap-token",
          ["orchestration:read"],
          requestMetadata,
          { proofKeyThumbprint: key.thumbprint },
        );
        const session = yield* sessions.verify(exchanged.access_token);
        const rpc = yield* serverAuth.issueWebSocketTicket(session, { use: "rpc" });
        const request = {
          method: "GET",
          url: `/ws?wsTicket=${Redacted.value(rpc.ticket)}&dpop=${key.sign({
            method: "GET",
            url: "http://192.168.1.50:3773/ws",
            token: Redacted.value(rpc.ticket),
            iat: Math.floor((yield* DateTime.now).epochMilliseconds / 1_000),
          })}`,
          cookies: {},
          headers: { host: "192.168.1.50:3773" },
        } as never;

        yield* serverAuth.authenticateWebSocketUpgrade(request, "rpc");
        const replayed = yield* Effect.flip(
          serverAuth.authenticateWebSocketUpgrade(request, "rpc"),
        );
        expect(replayed._tag).toBe("ServerAuthInvalidCredentialError");
        if (replayed._tag === "ServerAuthInvalidCredentialError") {
          expect(replayed.dpopFailureReason).toBe("replay");
        }
      }).pipe(
        Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: "desktop-bootstrap-token" })),
      ),
    );


















  },
);
