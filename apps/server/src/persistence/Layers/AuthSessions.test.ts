import { AuthSessionId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AuthSessionRepository } from "../Services/AuthSessions.ts";
import { AuthSessionRepositoryLive } from "./AuthSessions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const testLayer = it.layer(AuthSessionRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)));

const makeSessionId = (value: string) => AuthSessionId.make(value);

testLayer("AuthSessionRepository", (it) => {
  it.effect("revokes only stale desktop bootstrap/control bearer sessions", () =>
    Effect.gen(function* () {
      const repository = yield* AuthSessionRepository;
      const oldIssuedAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
      const freshIssuedAt = DateTime.makeUnsafe("2026-01-01T13:00:00.000Z");
      const expiresAt = DateTime.makeUnsafe("2026-01-30T00:00:00.000Z");
      const cutoff = DateTime.makeUnsafe("2026-01-01T12:00:00.000Z");
      const staleId = makeSessionId("stale-desktop-bootstrap-bearer");
      const staleControlId = makeSessionId("stale-desktop-control-bearer");
      const freshId = makeSessionId("fresh-desktop-bootstrap-bearer");
      const browserId = makeSessionId("stale-desktop-bootstrap-browser");
      const otherBearerId = makeSessionId("stale-other-bearer");
      const client = {
        label: null,
        ipAddress: null,
        userAgent: null,
        deviceType: "desktop" as const,
        os: null,
        browser: null,
      };

      yield* repository.create({
        sessionId: staleId,
        subject: "desktop-bootstrap",
        scopes: ["access:read", "access:write"],
        method: "bearer-access-token",
        client,
        issuedAt: oldIssuedAt,
        expiresAt,
      });
      yield* repository.create({
        sessionId: staleControlId,
        subject: "desktop-control",
        scopes: ["access:read", "access:write"],
        method: "bearer-access-token",
        client,
        issuedAt: oldIssuedAt,
        expiresAt,
      });
      yield* repository.create({
        sessionId: freshId,
        subject: "desktop-bootstrap",
        scopes: ["access:read", "access:write"],
        method: "bearer-access-token",
        client,
        issuedAt: freshIssuedAt,
        expiresAt,
      });
      yield* repository.create({
        sessionId: browserId,
        subject: "desktop-bootstrap",
        scopes: ["access:read", "access:write"],
        method: "browser-session-cookie",
        client,
        issuedAt: oldIssuedAt,
        expiresAt,
      });
      yield* repository.create({
        sessionId: otherBearerId,
        subject: "one-time-token",
        scopes: ["access:read"],
        method: "bearer-access-token",
        client,
        issuedAt: oldIssuedAt,
        expiresAt,
      });

      const revoked = yield* repository.revokeStaleDesktopBootstrapBearerSessions({
        issuedBefore: cutoff,
        revokedAt: cutoff,
      });
      const active = yield* repository.listActive({
        now: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.sameMembers([...revoked], [staleId, staleControlId]);
      assert.sameMembers(
        active.map((session) => session.sessionId),
        [freshId, browserId, otherBearerId],
      );
    }),
  );
});
