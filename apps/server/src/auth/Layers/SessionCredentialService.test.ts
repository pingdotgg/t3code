import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import { DateTime, Duration, Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";

import type { ServerConfigShape } from "../../config.ts";
import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { AuthSessionRepositoryLive } from "../../persistence/Layers/AuthSessions.ts";
import { AuthSessionRepository } from "../../persistence/Services/AuthSessions.ts";
import { SessionCredentialService } from "../Services/SessionCredentialService.ts";
import { ServerSecretStoreLive } from "./ServerSecretStore.ts";
import {
  listInactiveSessionIdsInBatches,
  SessionCredentialServiceBase,
  SessionCredentialServiceLive,
} from "./SessionCredentialService.ts";

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
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-session-test-" })));

const makeSessionCredentialLayer = (
  overrides?: Partial<Pick<ServerConfigShape, "desktopBootstrapToken">>,
) =>
  SessionCredentialServiceLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStoreLive),
    Layer.provide(makeServerConfigLayer(overrides)),
  );

const makeObservedSessionCredentialLayer = (input: {
  readonly failFirstGetById?: boolean;
  readonly failFirstListInactiveIds?: boolean;
  readonly observed: {
    pollCalls: number;
    polledSessionCounts: number[];
  };
}) => {
  const observedRepository = Layer.effect(
    AuthSessionRepository,
    Effect.gen(function* () {
      const repository = yield* AuthSessionRepository;
      let getByIdCalls = 0;
      return AuthSessionRepository.of({
        ...repository,
        getById: (request) =>
          Effect.suspend(() => {
            const call = getByIdCalls;
            getByIdCalls += 1;
            return input.failFirstGetById && call === 0
              ? Effect.fail(
                  new PersistenceSqlError({
                    operation: "test.getById",
                    detail: "transient session lookup failure",
                  }),
                )
              : repository.getById(request);
          }),
        listInactiveIds: (request) =>
          Effect.gen(function* () {
            input.observed.pollCalls += 1;
            input.observed.polledSessionCounts.push(request.sessionIds.length);
            if (input.failFirstListInactiveIds && input.observed.pollCalls === 1) {
              return yield* new PersistenceSqlError({
                operation: "test.listInactiveIds",
                detail: "transient inactive-session lookup failure",
              });
            }
            return yield* repository.listInactiveIds(request);
          }),
      });
    }),
  ).pipe(Layer.provide(AuthSessionRepositoryLive));

  return SessionCredentialServiceBase.pipe(
    Layer.provide(observedRepository),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStoreLive),
    Layer.provide(makeServerConfigLayer()),
  );
};

it.layer(NodeServices.layer)("SessionCredentialServiceLive", (it) => {
  it.effect("chunks durable inactive-session lookups below SQLite bind limits", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const sessionIds = Array.from({ length: 2_001 }, (_, index) =>
        AuthSessionId.make(`session-${String(index)}`),
      );
      const observedBatchSizes: number[] = [];

      const inactiveSessionIds = yield* listInactiveSessionIdsInBatches({
        sessionIds,
        now,
        listInactiveIds: ({ sessionIds: batch }) =>
          Effect.sync(() => {
            observedBatchSizes.push(batch.length);
            return batch.slice(0, 1);
          }),
      });

      expect(observedBatchSizes).toEqual([900, 900, 201]);
      expect(inactiveSessionIds).toEqual([
        AuthSessionId.make("session-0"),
        AuthSessionId.make("session-900"),
        AuthSessionId.make("session-1800"),
      ]);
    }),
  );

  it.effect("issues and verifies signed browser session tokens", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        subject: "desktop-bootstrap",
        role: "owner",
        client: {
          label: "Desktop app",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
          ipAddress: "127.0.0.1",
        },
      });
      const verified = yield* sessions.verify(issued.token);

      expect(verified.method).toBe("browser-session-cookie");
      expect(verified.subject).toBe("desktop-bootstrap");
      expect(verified.role).toBe("owner");
      expect(verified.client.label).toBe("Desktop app");
      expect(verified.client.browser).toBe("Electron");
      expect(verified.expiresAt?.toString()).toBe(issued.expiresAt.toString());
    }).pipe(Effect.provide(makeSessionCredentialLayer())),
  );
  it.effect("rejects malformed session tokens", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const error = yield* Effect.flip(sessions.verify("not-a-session-token"));

      expect(error._tag).toBe("SessionCredentialError");
      expect(error.message).toContain("Malformed session token");
    }).pipe(Effect.provide(makeSessionCredentialLayer())),
  );
  it.effect("verifies session tokens against the Effect clock", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        method: "bearer-session-token",
        subject: "test-clock",
      });
      const verified = yield* sessions.verify(issued.token);

      expect(verified.method).toBe("bearer-session-token");
      expect(verified.subject).toBe("test-clock");
      expect(verified.role).toBe("client");
    }).pipe(Effect.provide(Layer.merge(makeSessionCredentialLayer(), TestClock.layer()))),
  );

  it.effect("rejects websocket tokens once the parent session has expired", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        method: "bearer-session-token",
        subject: "short-lived",
        ttl: Duration.seconds(1),
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

      yield* TestClock.adjust(Duration.seconds(2));

      const error = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      expect(error.message).toContain("expired");
    }).pipe(Effect.provide(Layer.merge(makeSessionCredentialLayer(), TestClock.layer()))),
  );

  it.effect("lists active sessions, tracks connectivity, and revokes other sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const owner = yield* sessions.issue({
        subject: "desktop-bootstrap",
        role: "owner",
        client: {
          label: "Desktop app",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
        },
      });
      const client = yield* sessions.issue({
        subject: "one-time-token",
        role: "client",
        client: {
          label: "Julius iPhone",
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
      });

      yield* sessions.markConnected(client.sessionId);
      const beforeRevoke = yield* sessions.listActive();
      const revokedCount = yield* sessions.revokeAllExcept(owner.sessionId);
      const afterRevoke = yield* sessions.listActive();
      const revokedClient = yield* Effect.flip(sessions.verify(client.token));

      expect(beforeRevoke).toHaveLength(2);
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.connected).toBe(
        true,
      );
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.client.label).toBe(
        "Julius iPhone",
      );
      expect(
        beforeRevoke.find((entry) => entry.sessionId === owner.sessionId)?.client.deviceType,
      ).toBe("desktop");
      expect(revokedCount).toBe(1);
      expect(afterRevoke).toHaveLength(1);
      expect(afterRevoke[0]?.sessionId).toBe(owner.sessionId);
      expect(revokedClient.message).toContain("revoked");
    }).pipe(Effect.provide(makeSessionCredentialLayer())),
  );

  it.effect("persists lastConnectedAt on first connect and updates it after reconnect", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        subject: "reconnect-test",
        method: "bearer-session-token",
      });

      const beforeConnect = yield* sessions.listActive();
      expect(beforeConnect[0]?.lastConnectedAt).toBeNull();

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const firstConnect = yield* sessions.listActive();
      const firstConnectedAt = firstConnect[0]?.lastConnectedAt;

      expect(firstConnect[0]?.connected).toBe(true);
      expect(firstConnectedAt).not.toBeNull();

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const stillConnected = yield* sessions.listActive();

      expect(stillConnected[0]?.lastConnectedAt?.toString()).toBe(firstConnectedAt?.toString());

      yield* sessions.markDisconnected(issued.sessionId);
      yield* sessions.markDisconnected(issued.sessionId);
      const afterDisconnect = yield* sessions.listActive();

      expect(afterDisconnect[0]?.connected).toBe(false);
      expect(afterDisconnect[0]?.lastConnectedAt?.toString()).toBe(firstConnectedAt?.toString());

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const afterReconnect = yield* sessions.listActive();

      expect(afterReconnect[0]?.connected).toBe(true);
      expect(afterReconnect[0]?.lastConnectedAt).not.toBeNull();
      expect(afterReconnect[0]?.lastConnectedAt?.toString()).not.toBe(firstConnectedAt?.toString());
    }).pipe(Effect.provide(Layer.merge(makeSessionCredentialLayer(), TestClock.layer()))),
  );

  it.effect("closes waiters immediately on event-driven revocation", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({ method: "bearer-session-token" });
      const waiter = yield* sessions.waitUntilInactive(issued.sessionId).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* sessions.revoke(issued.sessionId);
      yield* Fiber.join(waiter);
    }).pipe(Effect.provide(makeSessionCredentialLayer())),
  );

  it.effect("detects revocation that happens before subscription setup", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const repository = yield* AuthSessionRepository;
      const issued = yield* sessions.issue({ method: "bearer-session-token" });
      const revokedAt = yield* DateTime.now;

      yield* repository.revoke({
        sessionId: issued.sessionId,
        revokedAt,
      });
      yield* sessions.waitUntilInactive(issued.sessionId);
    }).pipe(Effect.provide(makeSessionCredentialLayer())),
  );

  it.effect("retries transient session lookup failures without treating them as revocation", () => {
    const observed = { pollCalls: 0, polledSessionCounts: [] as number[] };
    return Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({ method: "bearer-session-token" });
      const waiter = yield* sessions.waitUntilInactive(issued.sessionId).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(250));
      expect(waiter.pollUnsafe()).toBeUndefined();
      yield* sessions.revoke(issued.sessionId);
      yield* Fiber.join(waiter);
    }).pipe(
      Effect.provide(
        makeObservedSessionCredentialLayer({
          failFirstGetById: true,
          observed,
        }).pipe(Layer.provideMerge(TestClock.layer())),
      ),
    );
  });

  it.effect("polls connected sessions once per interval regardless of socket count", () => {
    const observed = { pollCalls: 0, polledSessionCounts: [] as number[] };
    return Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const first = yield* sessions.issue({ method: "bearer-session-token" });
      const second = yield* sessions.issue({ method: "bearer-session-token" });

      yield* sessions.markConnected(first.sessionId);
      yield* sessions.markConnected(first.sessionId);
      yield* sessions.markConnected(second.sessionId);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(1));

      expect(observed.pollCalls).toBe(1);
      expect(observed.polledSessionCounts).toEqual([2]);
    }).pipe(
      Effect.provide(
        makeObservedSessionCredentialLayer({
          observed,
        }).pipe(Layer.provideMerge(TestClock.layer())),
      ),
    );
  });

  it.effect(
    "logs and retries transient durable poll failures without closing healthy sockets",
    () => {
      const observed = {
        pollCalls: 0,
        polledSessionCounts: [] as number[],
      };
      return Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({ method: "bearer-session-token" });
        yield* sessions.markConnected(issued.sessionId);
        const change = yield* Stream.runHead(sessions.streamChanges).pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Effect.yieldNow;
        expect(change.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust(Duration.seconds(1));
        yield* Effect.yieldNow;
        expect(observed.pollCalls).toBe(2);
        expect(change.pollUnsafe()).toBeUndefined();
      }).pipe(
        Effect.provide(
          makeObservedSessionCredentialLayer({
            failFirstListInactiveIds: true,
            observed,
          }).pipe(Layer.provideMerge(TestClock.layer())),
        ),
      );
    },
  );
});
