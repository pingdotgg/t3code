import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Turso from "@alchemy.run/turso";
import { organization } from "@alchemy.run/turso/Credentials";
import * as Hrana from "@alchemy.run/turso/Hrana";
import * as turso from "@distilled.cloud/turso/turso";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Turso.providers() });

const fixture = (name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(import.meta.dirname, "fixtures", name);
  });

/** Query a database out-of-band with a short-lived token. */
const sql = (database: string, hostname: string, statement: string) =>
  Effect.gen(function* () {
    const org = yield* organization;
    const { jwt } = yield* turso.createDatabaseToken({
      organizationSlug: org,
      databaseName: database,
      expiration: "5m",
    });
    return yield* Hrana.query({ url: `https://${hostname}`, authToken: jwt! }, statement);
  });

/** A per-stage, account-unique name for resources with a pinned `name`. */
const pinned = (suffix: string) =>
  Effect.gen(function* () {
    const stage = yield* Stage;
    return `alchemy-${stage}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  });

const expectDatabaseGone = (name: string) =>
  Effect.gen(function* () {
    const org = yield* organization;
    const exists = yield* turso.getDatabase({ organizationSlug: org, databaseName: name }).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFound", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (e) => !e, times: 10 }),
    );
    expect(exists).toBe(false);
  });

test.provider(
  "create, configure, migrate, seed, and delete a database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const org = yield* organization;
      const migrations = yield* fixture("migrations");
      const seed = yield* fixture("seed/users.sql");

      const app = (props: Partial<Turso.DatabaseProps>) =>
        Effect.gen(function* () {
          const group = yield* Turso.Group("Group", { location: "aws-us-east-1" });
          const db = yield* Turso.Database("Db", { group: group.name, ...props });
          return { group, db };
        });

      const { group, db } = yield* stack.deploy(app({}));
      expect(db.group).toBe(group.name);
      expect(db.url).toBe(`libsql://${db.hostname}`);
      expect(db.hostname).toContain(`-${org}.`);
      expect(db.blockWrites).toBe(false);
      expect(db.deleteProtection).toBe(false);

      // Configuration converges in place.
      const configured = yield* stack.deploy(
        app({ blockWrites: true, blockReads: true, deleteProtection: true }),
      );
      expect(configured.db.dbId).toBe(db.dbId);
      const config = yield* turso.getDatabaseConfiguration({
        organizationSlug: org,
        databaseName: db.name,
      });
      expect(config.block_writes).toBe(true);
      expect(config.block_reads).toBe(true);
      expect(config.delete_protection).toBe(true);

      // Removing the props reverts them.
      const reverted = yield* stack.deploy(app({}));
      expect(reverted.db.blockWrites).toBe(false);
      expect(reverted.db.blockReads).toBe(false);
      expect(reverted.db.deleteProtection).toBe(false);

      // Migrations, then SQL imports.
      const migrated = yield* stack.deploy(app({ migrations, importFiles: [seed] }));
      expect(Object.keys(migrated.db.migrationsHashes)).toHaveLength(2);
      expect(Object.keys(migrated.db.importHashes)).toEqual([seed]);
      const users = yield* sql(db.name, db.hostname, "SELECT name FROM users ORDER BY id");
      expect(users).toEqual([{ name: "alice" }, { name: "bob" }]);
      const posts = yield* sql(db.name, db.hostname, "SELECT count(*) AS n FROM posts");
      expect(posts).toEqual([{ n: 0 }]);
      const applied = yield* sql(
        db.name,
        db.hostname,
        "SELECT count(*) AS n FROM __alchemy_migrations",
      );
      expect(applied).toEqual([{ n: 2 }]);

      // A redeploy with unchanged files does not re-run the imports
      // (re-running them would violate the primary key).
      yield* stack.deploy(app({ migrations, importFiles: [seed] }));

      yield* stack.destroy();
      yield* expectDatabaseGone(db.name);
    }),
  { tags: ["provider:turso", "provider:turso:database", "live"], timeout: 180_000 },
);

test.provider(
  "moving a database to another group replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = (target: "A" | "B") =>
        Effect.gen(function* () {
          // Keep both groups deployed across the replacement.
          const a = yield* Turso.Group("GroupA", { location: "aws-us-east-1" });
          const b = yield* Turso.Group("GroupB", { location: "aws-us-east-1" });
          return yield* Turso.Database("Db", { group: target === "A" ? a.name : b.name });
        });

      const first = yield* stack.deploy(app("A"));
      const second = yield* stack.deploy(app("B"));
      expect(second.dbId).not.toBe(first.dbId);
      expect(second.group).not.toBe(first.group);
      yield* expectDatabaseGone(first.name);

      yield* stack.destroy();
      yield* expectDatabaseGone(second.name);
    }),
  { tags: ["provider:turso", "provider:turso:database", "live"], timeout: 180_000 },
);

test.provider(
  "fork a database from another with seed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const migrations = yield* fixture("migrations");
      const seed = yield* fixture("seed/users.sql");

      const app = (withFork: boolean) =>
        Effect.gen(function* () {
          const group = yield* Turso.Group("Group", { location: "aws-us-east-1" });
          const source = yield* Turso.Database("Source", {
            group: group.name,
            migrations,
            importFiles: [seed],
          });
          const fork = withFork
            ? yield* Turso.Database("Fork", {
                group: group.name,
                seed: { type: "database", name: source.name },
              })
            : undefined;
          return { source, fork };
        });

      // Deploy the source first so the fork copies its seeded data.
      yield* stack.deploy(app(false));
      const { fork } = yield* stack.deploy(app(true));
      const users = yield* sql(fork!.name, fork!.hostname, "SELECT name FROM users ORDER BY id");
      expect(users).toEqual([{ name: "alice" }, { name: "bob" }]);

      yield* stack.destroy();
      yield* expectDatabaseGone(fork!.name);
    }),
  { tags: ["provider:turso", "provider:turso:database", "live"], timeout: 180_000 },
);

test.provider(
  "a failing import rolls back and leaves no partial schema",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const broken = yield* fixture("seed/broken.sql");

      const app = (importFiles: string[]) =>
        Effect.gen(function* () {
          const group = yield* Turso.Group("Group", { location: "aws-us-east-1" });
          return yield* Turso.Database("Db", { group: group.name, importFiles });
        });

      const db = yield* stack.deploy(app([]));
      const error = yield* stack.deploy(app([broken])).pipe(Effect.flip);
      expect(String(error)).toContain("missing_table");
      const tables = yield* sql(
        db.name,
        db.hostname,
        "SELECT name FROM sqlite_master WHERE name = 'half_applied'",
      );
      expect(tables).toEqual([]);

      yield* stack.destroy();
      yield* expectDatabaseGone(db.name);
    }),
  { tags: ["provider:turso", "provider:turso:database", "live"], timeout: 180_000 },
);

test.provider(
  "moving a database with a pinned name deletes the old one first",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* pinned("pinned-db");

      const app = (target: "A" | "B") =>
        Effect.gen(function* () {
          const a = yield* Turso.Group("GroupA", { location: "aws-us-east-1" });
          const b = yield* Turso.Group("GroupB", { location: "aws-us-east-1" });
          return yield* Turso.Database("Db", { name, group: target === "A" ? a.name : b.name });
        });

      const first = yield* stack.deploy(app("A"));
      expect(first.name).toBe(name);
      const second = yield* stack.deploy(app("B"));
      expect(second.name).toBe(name);
      expect(second.dbId).not.toBe(first.dbId);
      expect(second.group).not.toBe(first.group);

      yield* stack.destroy();
      yield* expectDatabaseGone(name);
    }),
  { tags: ["provider:turso", "provider:turso:database", "live"], timeout: 180_000 },
);

test.provider(
  "a database with a pinned name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const org = yield* organization;
      const name = yield* pinned("foreign-db");

      const group = yield* stack.deploy(Turso.Group("Group", { location: "aws-us-east-1" }));
      yield* turso
        .deleteDatabase({ organizationSlug: org, databaseName: name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      const foreign = yield* turso.createDatabase({
        organizationSlug: org,
        name,
        group: group.name,
      });

      const app = (allow: boolean) =>
        Effect.gen(function* () {
          const g = yield* Turso.Group("Group", { location: "aws-us-east-1" });
          return yield* Turso.Database("Db", { name, group: g.name }).pipe(adopt(allow));
        });

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.dbId).toBe(foreign.database?.DbId);

      // Once adopted, later deploys need no adopt flag.
      expect((yield* stack.deploy(app(false))).dbId).toBe(adopted.dbId);

      yield* stack.destroy();
      yield* expectDatabaseGone(name);
    }),
  { tags: ["provider:turso", "provider:turso:database", "live"], timeout: 180_000 },
);

test.provider(
  "migrations honor a custom table and reject rewritten history",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "turso-migrations-" });
      yield* fs.writeFileString(
        path.join(dir, "0001_items.sql"),
        "CREATE TABLE items (id INTEGER PRIMARY KEY);",
      );

      const app = Effect.gen(function* () {
        const group = yield* Turso.Group("Group", { location: "aws-us-east-1" });
        return yield* Turso.Database("Db", {
          group: group.name,
          migrations: { dir, table: "schema_migrations" },
        });
      });

      const db = yield* stack.deploy(app);
      expect(db.migrationsTable).toBe("schema_migrations");
      expect(
        yield* sql(db.name, db.hostname, "SELECT count(*) AS n FROM schema_migrations"),
      ).toEqual([{ n: 1 }]);

      // A second file is applied on the next deploy.
      yield* fs.writeFileString(
        path.join(dir, "0002_tags.sql"),
        "CREATE TABLE tags (id INTEGER PRIMARY KEY);",
      );
      yield* stack.deploy(app);
      expect(
        yield* sql(db.name, db.hostname, "SELECT count(*) AS n FROM schema_migrations"),
      ).toEqual([{ n: 2 }]);

      // Editing an applied file fails the deploy.
      yield* fs.writeFileString(
        path.join(dir, "0001_items.sql"),
        "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);",
      );
      const rewritten = yield* stack.deploy(app).pipe(Effect.flip);
      expect(String(rewritten)).toContain("0001_items.sql");

      yield* stack.destroy();
      yield* expectDatabaseGone(db.name);
    }).pipe(Effect.scoped),
  { tags: ["provider:turso", "provider:turso:database", "live"], timeout: 180_000 },
);

test.provider(
  "fork a database from a point in time",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const source = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Turso.Group("Group", { location: "aws-us-east-1" });
          return yield* Turso.Database("Source", { group: group.name });
        }),
      );
      yield* sql(source.name, source.hostname, "CREATE TABLE t (v INTEGER)");
      yield* Effect.sleep("3 seconds");
      const timestamp = new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

      const { fork } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Turso.Group("Group", { location: "aws-us-east-1" });
          const src = yield* Turso.Database("Source", { group: group.name });
          const fork = yield* Turso.Database("Fork", {
            group: group.name,
            seed: { type: "database", name: src.name, timestamp },
          });
          return { fork };
        }),
      );
      expect(fork.dbId).not.toBe(source.dbId);
      expect(
        yield* sql(fork.name, fork.hostname, "SELECT name FROM sqlite_master WHERE name = 't'"),
      ).toEqual([{ name: "t" }]);

      yield* stack.destroy();
    }),
  { tags: ["provider:turso", "provider:turso:database", "live"], timeout: 180_000 },
);
