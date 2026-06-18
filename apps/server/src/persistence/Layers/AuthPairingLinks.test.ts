import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { AuthPairingLinkRepository } from "../Services/AuthPairingLinks.ts";
import { AuthPairingLinkRepositoryLive } from "./AuthPairingLinks.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const testLayer = it.layer(
  AuthPairingLinkRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
);

testLayer("AuthPairingLinkRepository", (it) => {
  it.effect("deletes only expired pairing links for the requested subject", () =>
    Effect.gen(function* () {
      const repository = yield* AuthPairingLinkRepository;
      const old = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
      const now = DateTime.makeUnsafe("2026-01-01T00:01:00.000Z");
      const future = DateTime.makeUnsafe("2026-01-01T00:02:00.000Z");

      yield* repository.create({
        id: "expired-desktop-bootstrap",
        credential: "expired-desktop-bootstrap-token",
        method: "one-time-token",
        scopes: ["access:read", "access:write"],
        subject: "desktop-bootstrap",
        label: "VS Code",
        proofKeyThumbprint: null,
        createdAt: old,
        expiresAt: old,
      });
      yield* repository.create({
        id: "fresh-desktop-bootstrap",
        credential: "fresh-desktop-bootstrap-token",
        method: "one-time-token",
        scopes: ["access:read", "access:write"],
        subject: "desktop-bootstrap",
        label: "VS Code",
        proofKeyThumbprint: null,
        createdAt: now,
        expiresAt: future,
      });
      yield* repository.create({
        id: "expired-manual-token",
        credential: "expired-manual-token",
        method: "one-time-token",
        scopes: ["access:read"],
        subject: "one-time-token",
        label: null,
        proofKeyThumbprint: null,
        createdAt: old,
        expiresAt: old,
      });

      const deleted = yield* repository.deleteExpired({
        now,
        subject: "desktop-bootstrap",
      });
      const expiredDesktopBootstrap = yield* repository.getByCredential({
        credential: "expired-desktop-bootstrap-token",
      });
      const freshDesktopBootstrap = yield* repository.getByCredential({
        credential: "fresh-desktop-bootstrap-token",
      });
      const expiredManualToken = yield* repository.getByCredential({
        credential: "expired-manual-token",
      });

      assert.equal(deleted, 1);
      assert.isTrue(Option.isNone(expiredDesktopBootstrap));
      assert.isTrue(Option.isSome(freshDesktopBootstrap));
      assert.isTrue(Option.isSome(expiredManualToken));
    }),
  );
});
