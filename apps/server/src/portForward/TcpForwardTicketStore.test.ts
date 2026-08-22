import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as TcpForwardTicketStore from "./TcpForwardTicketStore.ts";

const sessionStoreLayer = SessionStore.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-tcp-forward-ticket-test-" })),
);

const testLayer = TcpForwardTicketStore.layer.pipe(Layer.provideMerge(sessionStoreLayer));

it.layer(NodeServices.layer)("TcpForwardTicketStore", (it) => {
  it("describes the failed issuance stage and session", () => {
    const error = new TcpForwardTicketStore.TcpForwardTicketIssueError({
      stage: "generate-ticket",
      sessionId: AuthSessionId.make("session-a"),
      cause: new Error("random source unavailable"),
    });

    expect(error.message).toContain("generate-ticket");
    expect(error.message).toContain("session-a");
  });

  it.effect("binds a ticket to its destination and consumes it only once", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const store = yield* TcpForwardTicketStore.TcpForwardTicketStore;
      const session = yield* sessions.issue({
        subject: "desktop",
        scopes: ["terminal:operate"],
      });
      const issued = yield* store.issue({
        sessionId: session.sessionId,
        remoteHost: "127.0.0.1",
        remotePort: 4321,
      });

      const consumed = yield* store.consume(issued.ticket);
      expect(consumed.remoteHost).toBe("127.0.0.1");
      expect(consumed.remotePort).toBe(4321);
      expect(consumed.session.sessionId).toBe(session.sessionId);

      const replay = yield* Effect.flip(store.consume(issued.ticket));
      expect(replay._tag).toBe("TcpForwardTicketInvalidError");
      expect(replay.reason).toBe("unknown");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects expired tickets", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const store = yield* TcpForwardTicketStore.TcpForwardTicketStore;
      const session = yield* sessions.issue({
        subject: "desktop",
        scopes: ["terminal:operate"],
      });
      const issued = yield* store.issue({
        sessionId: session.sessionId,
        remoteHost: "127.0.0.1",
        remotePort: 3000,
      });
      yield* TestClock.adjust(Duration.seconds(31));

      const expired = yield* Effect.flip(store.consume(issued.ticket));
      expect(expired._tag).toBe("TcpForwardTicketInvalidError");
      expect(expired.reason).toBe("expired");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects sessions without terminal access", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const store = yield* TcpForwardTicketStore.TcpForwardTicketStore;
      const session = yield* sessions.issue({
        subject: "read-only",
        scopes: ["orchestration:read"],
      });
      const issued = yield* store.issue({
        sessionId: AuthSessionId.make(session.sessionId),
        remoteHost: "127.0.0.1",
        remotePort: 3000,
      });

      const rejected = yield* Effect.flip(store.consume(issued.ticket));
      expect(rejected._tag).toBe("TcpForwardTicketInvalidError");
      expect(rejected.reason).toBe("scope-missing");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a ticket after its parent session is revoked", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const store = yield* TcpForwardTicketStore.TcpForwardTicketStore;
      const session = yield* sessions.issue({
        subject: "desktop",
        scopes: ["terminal:operate"],
      });
      const issued = yield* store.issue({
        sessionId: session.sessionId,
        remoteHost: "127.0.0.1",
        remotePort: 3000,
      });
      yield* sessions.revoke(session.sessionId);

      const revoked = yield* Effect.flip(store.consume(issued.ticket));
      expect(revoked._tag).toBe("TcpForwardTicketInvalidError");
      expect(revoked.reason).toBe("token-rejected");
      expect(revoked.cause).toBeDefined();
    }).pipe(Effect.provide(testLayer)),
  );
});
