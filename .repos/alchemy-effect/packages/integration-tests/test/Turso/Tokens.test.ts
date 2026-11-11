import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Turso from "@alchemy.run/turso";
import * as Hrana from "@alchemy.run/turso/Hrana";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Turso.providers() });

const run = (hostname: string, token: Redacted.Redacted<string>, statement: string) =>
  Hrana.query({ url: `https://${hostname}`, authToken: token }, statement);

test.provider(
  "database tokens authorize SQL at their access level",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = (readOnlyExpiration?: string) =>
        Effect.gen(function* () {
          const group = yield* Turso.Group("Group", { location: "aws-us-east-1" });
          const db = yield* Turso.Database("Db", { group: group.name });
          const full = yield* Turso.DatabaseToken("Full", { database: db.name });
          const readOnly = yield* Turso.DatabaseToken("ReadOnly", {
            database: db.name,
            authorization: "read-only",
            expiration: readOnlyExpiration,
          });
          return { db, full, readOnly };
        });

      const { db, full, readOnly } = yield* stack.deploy(app("1d"));
      expect(full.expiresAt).toBeUndefined();
      expect(readOnly.expiresAt).toBeGreaterThan(Date.now());
      expect(readOnly.dbId).toBe(db.dbId);

      yield* run(db.hostname, full.token, "CREATE TABLE t (v INTEGER)");
      yield* run(db.hostname, full.token, "INSERT INTO t VALUES (1)");
      expect(yield* run(db.hostname, readOnly.token, "SELECT v FROM t")).toEqual([{ v: 1 }]);
      const denied = yield* run(db.hostname, readOnly.token, "INSERT INTO t VALUES (2)").pipe(
        Effect.flip,
      );
      expect(denied._tag).toBe("Turso::HranaError");

      // An unchanged redeploy keeps the tokens; a prop change re-mints.
      const same = yield* stack.deploy(app("1d"));
      expect(Redacted.value(same.full.token)).toBe(Redacted.value(full.token));
      expect(Redacted.value(same.readOnly.token)).toBe(Redacted.value(readOnly.token));
      const rotated = yield* stack.deploy(app("2d"));
      expect(Redacted.value(rotated.readOnly.token)).not.toBe(Redacted.value(readOnly.token));
      expect(rotated.readOnly.expiresAt).toBeGreaterThan(readOnly.expiresAt!);

      yield* stack.destroy();
    }),
  { tags: ["provider:turso", "provider:turso:databasetoken", "live"], timeout: 180_000 },
);

test.provider(
  "a group token authorizes every database in the group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { a, b, token } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Turso.Group("Group", { location: "aws-us-east-1" });
          const a = yield* Turso.Database("A", { group: group.name });
          const b = yield* Turso.Database("B", { group: group.name });
          const token = yield* Turso.GroupToken("Token", { group: group.name });
          return { a, b, token };
        }),
      );
      expect(token.groupId).toBeTruthy();
      expect(yield* run(a.hostname, token.token, "SELECT 1 AS one")).toEqual([{ one: 1 }]);
      expect(yield* run(b.hostname, token.token, "SELECT 2 AS two")).toEqual([{ two: 2 }]);

      yield* stack.destroy();
    }),
  { tags: ["provider:turso", "provider:turso:grouptoken", "live"], timeout: 180_000 },
);

test.provider(
  "a token close to expiry is re-minted on deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = Effect.gen(function* () {
        const group = yield* Turso.Group("Group", { location: "aws-us-east-1" });
        const db = yield* Turso.Database("Db", { group: group.name });
        // Expires within the hour, so every deploy re-mints it.
        return yield* Turso.DatabaseToken("Short", { database: db.name, expiration: "30m" });
      });

      const first = yield* stack.deploy(app);
      // Turso tokens are deterministic per second of issue time.
      yield* Effect.sleep("1100 millis");
      const second = yield* stack.deploy(app);
      expect(Redacted.value(second.token)).not.toBe(Redacted.value(first.token));
      expect(second.expiresAt).toBeGreaterThan(first.expiresAt!);

      yield* stack.destroy();
    }),
  { tags: ["provider:turso", "provider:turso:databasetoken", "live"], timeout: 180_000 },
);
