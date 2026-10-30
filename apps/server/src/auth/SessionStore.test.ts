import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { base64UrlDecodeUtf8, base64UrlEncode, signPayload } from "./utils.ts";

const layerServerConfig = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-session-test-" })));

const layerServerEnvironment = (environmentId: EnvironmentId) =>
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(environmentId),
  });

const layerSessionStore = (
  overrides?: Partial<ServerConfig.ServerConfig["Service"]>,
  environmentId = EnvironmentId.make("test-environment"),
) =>
  SessionStore.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(layerServerEnvironment(environmentId)),
    Layer.provide(layerServerConfig(overrides)),
  );

const relaySessionInput = {
  subject: "managed-relay-bootstrap",
  method: "dpop-access-token",
  proofKeyThumbprint: "relay-proof-key",
  ttl: Duration.hours(1),
  client: { label: "Relay desktop", deviceType: "desktop" },
} as const;

const makeDiskSessionStoreLayer = Effect.fn("makeDiskSessionStoreLayer")(function* (
  baseDir: string,
  token?: string,
) {
  const devUrl = new URL("http://127.0.0.1:5173");
  const paths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl, {
    baseDirIsExplicit: true,
  });
  yield* ServerConfig.ensureServerDirectories(paths);
  const layerPersistence = SqlitePersistence.layerFromPath(paths.dbPath);
  return SessionStore.layer.pipe(
    Layer.provide(layerPersistence),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(layerServerEnvironment(EnvironmentId.make(baseDir))),
    Layer.provide(
      layerServerConfig({
        ...paths,
        baseDir,
        mode: "web",
        devUrl,
        ...(token === undefined ? {} : { devAuthToken: Redacted.make(token) }),
      }),
    ),
  );
});

it.layer(NodeServices.layer)("SessionStore.layer", (it) => {
  it.effect.each(["revoke", "revokeAllExcept", "replace"] as const)(
    "invalidates every connection for a session on %s and leaves other sessions active",
    (operation) =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const owner = yield* sessions.issue({ subject: "owner" });
        const client = yield* sessions.issue(relaySessionInput);
        expect(yield* sessions.isActive(client.sessionId)).toBe(true);
        const ownerInvalidated = yield* Deferred.make<void>();
        yield* sessions
          .awaitInvalidation(owner.sessionId)
          .pipe(
            Effect.andThen(Deferred.succeed(ownerInvalidated, undefined)),
            Effect.forkScoped({ startImmediately: true }),
          );
        const first = yield* sessions
          .awaitInvalidation(client.sessionId)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const second = yield* sessions
          .awaitInvalidation(client.sessionId)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        if (operation === "revoke") yield* sessions.revoke(client.sessionId);
        else if (operation === "revokeAllExcept") yield* sessions.revokeAllExcept(owner.sessionId);
        else yield* sessions.issue({ ...relaySessionInput, replaceSessionId: client.sessionId });
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(yield* Deferred.isDone(ownerInvalidated)).toBe(false);
        expect(yield* sessions.isActive(owner.sessionId)).toBe(true);
        expect(yield* sessions.isActive(client.sessionId)).toBe(false);
        yield* sessions.awaitInvalidation(client.sessionId);
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("expires a connected session at its credential deadline", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const client = yield* sessions.issue(relaySessionInput);
      yield* sessions.markConnected(client.sessionId);
      const invalidated = yield* Deferred.make<void>();
      const watcher = yield* sessions
        .awaitInvalidation(client.sessionId)
        .pipe(
          Effect.andThen(Deferred.succeed(invalidated, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
      expect(yield* sessions.isActive(client.sessionId)).toBe(true);
      yield* TestClock.adjust(Duration.minutes(59));
      expect(yield* Deferred.isDone(invalidated)).toBe(false);
      yield* TestClock.adjust(Duration.minutes(1));
      yield* Fiber.join(watcher);
      yield* sessions.awaitInvalidation(client.sessionId);
      expect(yield* sessions.isActive(client.sessionId)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("keys remote cookies by environment identity instead of state directory", () =>
    Effect.gen(function* () {
      const cookieName = (stateDir: string, environmentId: EnvironmentId) =>
        Effect.gen(function* () {
          const sessions = yield* SessionStore.SessionStore;
          return sessions.cookieName;
        }).pipe(
          Effect.provide(
            layerSessionStore({ mode: "web", host: "192.168.1.50", stateDir }, environmentId),
          ),
        );

      const original = yield* cookieName("/srv/t3-one", EnvironmentId.make("environment-one"));
      const moved = yield* cookieName("/srv/t3-moved", EnvironmentId.make("environment-one"));
      const other = yield* cookieName("/srv/t3-one", EnvironmentId.make("environment-two"));

      expect(moved).toBe(original);
      expect(other).not.toBe(original);
    }),
  );

  it.effect("keeps reusable dev auth local across disk-backed stores and restarts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const token = "reusable-dev-auth-token-that-is-long-enough";
      const baseA = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dev-auth-a-" });
      const baseB = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dev-auth-b-" });
      const layerA = yield* makeDiskSessionStoreLayer(baseA, token);
      const fromA = yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(token);
        const local = yield* sessions.issue({ subject: "environment-a" });
        const ticket = yield* sessions.issueWebSocketToken(local.sessionId);
        yield* sessions.revoke(dev.sessionId);
        return { dev, local, ticket };
      }).pipe(Effect.provide(layerA), Effect.scoped);

      const layerB = yield* makeDiskSessionStoreLayer(baseB, token);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(token);
        expect(dev.sessionId).toBe(fromA.dev.sessionId);
        expect((yield* Effect.flip(sessions.verify(fromA.local.token)))._tag).toBe(
          "InvalidSessionTokenSignatureError",
        );
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(fromA.ticket.token)))._tag).toBe(
          "InvalidWebSocketTokenSignatureError",
        );
      }).pipe(Effect.provide(layerB), Effect.scoped);

      const layerReopenedB = yield* makeDiskSessionStoreLayer(baseB, token);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(token);
        expect(dev.sessionId).toBe(fromA.dev.sessionId);
        const ticket = yield* sessions.issueWebSocketToken(dev.sessionId);
        expect((yield* sessions.verifyWebSocketToken(ticket.token)).sessionId).toBe(dev.sessionId);
      }).pipe(Effect.provide(layerReopenedB), Effect.scoped);

      const layerReopenedA = yield* makeDiskSessionStoreLayer(baseA, token);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        expect((yield* Effect.flip(sessions.verify(token)))._tag).toBe("SessionTokenRevokedError");
      }).pipe(Effect.provide(layerReopenedA), Effect.scoped);
    }),
  );

  it.effect("invalidates old dev credentials and tickets after rotation or removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dev-auth-rotation-" });
      const oldToken = "old-reusable-dev-auth-token-that-is-long-enough";
      const newToken = "new-reusable-dev-auth-token-that-is-long-enough";
      const layerInitial = yield* makeDiskSessionStoreLayer(baseDir, oldToken);
      const old = yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const dev = yield* sessions.verify(oldToken);
        const ticket = yield* sessions.issueWebSocketToken(dev.sessionId);
        return { dev, ticket };
      }).pipe(Effect.provide(layerInitial), Effect.scoped);

      const layerRotated = yield* makeDiskSessionStoreLayer(baseDir, newToken);
      const rotated = yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        expect((yield* Effect.flip(sessions.verify(oldToken)))._tag).toBe(
          "MalformedSessionTokenError",
        );
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(old.ticket.token)))._tag).toBe(
          "UnknownWebSocketSessionError",
        );
        expect(
          (yield* sessions.listActive()).some((row) => row.sessionId === old.dev.sessionId),
        ).toBe(true);
        const dev = yield* sessions.verify(newToken);
        const ticket = yield* sessions.issueWebSocketToken(dev.sessionId);
        return { dev, ticket };
      }).pipe(Effect.provide(layerRotated), Effect.scoped);

      const layerRemoved = yield* makeDiskSessionStoreLayer(baseDir);
      yield* Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        expect((yield* Effect.flip(sessions.verify(newToken)))._tag).toBe(
          "MalformedSessionTokenError",
        );
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(rotated.ticket.token)))._tag).toBe(
          "UnknownWebSocketSessionError",
        );
        expect(
          (yield* sessions.listActive()).some((row) => row.sessionId === rotated.dev.sessionId),
        ).toBe(true);
      }).pipe(Effect.provide(layerRemoved), Effect.scoped);
    }),
  );

  it.effect("carries a runtime-mode ceiling only on sessions issued with one", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const capped = yield* sessions.issue({
        subject: "mcp-client",
        method: "bearer-access-token",
        runtimeModeCeiling: "auto",
      });
      const uncapped = yield* sessions.issue({ method: "bearer-access-token" });

      expect((yield* sessions.verify(capped.token)).runtimeModeCeiling).toBe("auto");
      expect((yield* sessions.verify(uncapped.token)).runtimeModeCeiling).toBeUndefined();
    }).pipe(Effect.provide(layerSessionStore())),
  );
  it.effect("keeps recorded scopes unchanged for both token versions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const legacyScopes = ["orchestration:read", "terminal:operate", "review:write"] as const;
      const issued = yield* sessions.issue({ subject: "one-time-token", scopes: legacyScopes });
      const [encodedPayload] = issued.token.split(".");
      const currentClaims = base64UrlDecodeUtf8(encodedPayload!);
      expect(currentClaims).toContain('"v":1');
      const legacyPayload = base64UrlEncode(currentClaims.replace('"v":1', '"v":2'));
      const secret = yield* secrets.getOrCreateRandom("server-signing-key", 32);
      const legacyToken = `${legacyPayload}.${signPayload(legacyPayload, secret)}`;

      expect((yield* sessions.verify(issued.token)).scopes).toEqual(legacyScopes);
      expect((yield* sessions.verify(legacyToken)).scopes).toEqual(legacyScopes);
    }).pipe(
      Effect.provide(
        SessionStore.layer.pipe(
          Layer.provideMerge(ServerSecretStore.layer),
          Layer.provide(SqlitePersistence.layerMemory),
          Layer.provide(layerServerEnvironment(EnvironmentId.make("test-environment"))),
          Layer.provide(layerServerConfig()),
        ),
      ),
    ),
  );

  it.effect("atomically replaces active sessions with the same subject and method", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const browser = yield* sessions.issue({
        subject: "desktop-bootstrap",
        method: "browser-session-cookie",
      });
      const [firstBearer, secondBearer] = yield* Effect.all(
        [
          sessions.issue({
            subject: "desktop-bootstrap",
            method: "bearer-access-token",
            replaceActiveForSubjectAndMethod: true,
          }),
          sessions.issue({
            subject: "desktop-bootstrap",
            method: "bearer-access-token",
            replaceActiveForSubjectAndMethod: true,
          }),
        ],
        { concurrency: "unbounded" },
      );

      const active = yield* sessions.listActive();
      const bearerVerification = yield* Effect.all([
        sessions.verify(firstBearer.token).pipe(Effect.option),
        sessions.verify(secondBearer.token).pipe(Effect.option),
      ]);

      expect(active).toHaveLength(2);
      expect(active.find((entry) => entry.sessionId === browser.sessionId)).toBeDefined();
      expect(
        active.filter(
          (entry) =>
            entry.subject === "desktop-bootstrap" && entry.method === "bearer-access-token",
        ),
      ).toHaveLength(1);
      expect(bearerVerification.filter(Option.isSome)).toHaveLength(1);
    }).pipe(Effect.provide(layerSessionStore())),
  );

  it.effect("keeps the previous desktop session valid when replacement fails", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const sql = yield* SqlClient.SqlClient;
      const previous = yield* sessions.issue({
        subject: "desktop-bootstrap",
        method: "bearer-access-token",
      });
      yield* sql`
        CREATE TRIGGER reject_auth_session_insert BEFORE INSERT ON auth_sessions
        BEGIN
          SELECT RAISE(ABORT, 'simulated insert failure');
        END
      `;

      const error = yield* sessions
        .issue({
          subject: "desktop-bootstrap",
          method: "bearer-access-token",
          replaceActiveForSubjectAndMethod: true,
        })
        .pipe(Effect.flip);

      expect(error._tag).toBe("SessionCredentialIssueError");
      expect((yield* sessions.verify(previous.token)).sessionId).toBe(previous.sessionId);
      expect((yield* sessions.listActive()).map((session) => session.sessionId)).toEqual([
        previous.sessionId,
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(layerSessionStore(), SqlitePersistence.layerMemory))),
  );

  it.effect.each(["insert", "revoke"] as const)(
    "keeps existing browser sessions valid when replacement cannot %s",
    (operation) =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const sql = yield* SqlClient.SqlClient;
        const previous = yield* sessions.issue({ subject: "one-time-token" });
        const unrelated = yield* sessions.issue({ subject: "one-time-token" });
        if (operation === "insert") {
          yield* sql`
            CREATE TRIGGER reject_auth_session_insert BEFORE INSERT ON auth_sessions
            BEGIN
              SELECT RAISE(ABORT, 'simulated insert failure');
            END
          `;
        } else {
          yield* sql`
            CREATE TRIGGER reject_auth_session_revocation BEFORE UPDATE OF revoked_at ON auth_sessions
            BEGIN
              SELECT RAISE(ABORT, 'simulated revocation failure');
            END
          `;
        }

        const error = yield* sessions
          .issue({
            subject: "replacement-pairing",
            scopes: ["orchestration:read"],
            replaceSessionId: previous.sessionId,
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("SessionCredentialIssueError");
        expect((yield* sessions.verify(previous.token)).sessionId).toBe(previous.sessionId);
        expect((yield* sessions.verify(unrelated.token)).sessionId).toBe(unrelated.sessionId);
        expect((yield* sessions.listActive()).map((session) => session.sessionId).sort()).toEqual(
          [previous.sessionId, unrelated.sessionId].sort(),
        );
      }).pipe(Effect.provide(Layer.mergeAll(layerSessionStore(), SqlitePersistence.layerMemory))),
  );

  it.effect("rejects websocket tokens once the parent session has expired", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "short-lived",
        ttl: Duration.seconds(1),
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

      yield* TestClock.adjust(Duration.seconds(2));

      const error = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      expect(error._tag).toBe("WebSocketSessionExpiredError");
      if (error._tag === "WebSocketSessionExpiredError") {
        expect(error.sessionId).toBe(issued.sessionId);
        expect(error.expiresAt.epochMilliseconds).toBe(issued.expiresAt.epochMilliseconds);
        expect(error.observedAt.epochMilliseconds).toBeGreaterThan(
          error.expiresAt.epochMilliseconds,
        );
      }
    }).pipe(Effect.provide(Layer.merge(layerSessionStore(), TestClock.layer()))),
  );

  it.effect("lists active sessions, tracks connectivity, and revokes other sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const administrative = yield* sessions.issue({
        subject: "desktop-bootstrap",
        scopes: ["orchestration:read", "access:write"],
        client: {
          label: "Desktop app",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
        },
      });
      const client = yield* sessions.issue({
        subject: "one-time-token",
        scopes: ["orchestration:read"],
        client: {
          label: "Julius iPhone",
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
      });
      const clientWebSocket = yield* sessions.issueWebSocketToken(client.sessionId);

      yield* sessions.markConnected(client.sessionId);
      const beforeRevoke = yield* sessions.listActive();
      const revokedCount = yield* sessions.revokeAllExcept(administrative.sessionId);
      const afterRevoke = yield* sessions.listActive();
      const revokedClient = yield* Effect.flip(sessions.verify(client.token));
      const revokedClientWebSocket = yield* Effect.flip(
        sessions.verifyWebSocketToken(clientWebSocket.token),
      );

      expect(beforeRevoke).toHaveLength(2);
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.connected).toBe(
        true,
      );
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.client.label).toBe(
        "Julius iPhone",
      );
      expect(
        beforeRevoke.find((entry) => entry.sessionId === administrative.sessionId)?.client
          .deviceType,
      ).toBe("desktop");
      expect(revokedCount).toBe(1);
      expect(afterRevoke).toHaveLength(1);
      expect(afterRevoke[0]?.sessionId).toBe(administrative.sessionId);
      expect(revokedClient._tag).toBe("SessionTokenRevokedError");
      if (revokedClient._tag === "SessionTokenRevokedError") {
        expect(revokedClient.sessionId).toBe(client.sessionId);
        expect(revokedClient.revokedAt.epochMilliseconds).toBeGreaterThanOrEqual(0);
      }
      expect(revokedClientWebSocket._tag).toBe("WebSocketSessionRevokedError");
      if (revokedClientWebSocket._tag === "WebSocketSessionRevokedError") {
        expect(revokedClientWebSocket.sessionId).toBe(client.sessionId);
        expect(revokedClientWebSocket.revokedAt.epochMilliseconds).toBeGreaterThanOrEqual(0);
      }
    }).pipe(Effect.provide(layerSessionStore())),
  );
});
