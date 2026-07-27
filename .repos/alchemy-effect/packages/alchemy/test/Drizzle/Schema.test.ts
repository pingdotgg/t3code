import * as Drizzle from "@/Drizzle";
import * as Provider from "@/Provider";
import * as Stack from "@/Stack";
import { State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Drizzle.providers() });

const DRIZZLE_ORIGIN_UUID = "00000000-0000-0000-0000-000000000000";

// Minimal drizzle-orm schema source — enough for `generateDrizzleJson`
// to produce a non-empty snapshot.
const SCHEMA_SOURCE = `
import { pgTable, serial, text } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});
`;

const DRIFTED_SCHEMA_SOURCE =
  SCHEMA_SOURCE +
  `\nexport const posts = pgTable("posts", {\n  id: serial("id").primaryKey(),\n  title: text("title").notNull(),\n});\n`;

const SQLITE_SCHEMA_SOURCE = `
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});
`;

const SQLITE_DRIFTED_SCHEMA_SOURCE =
  SQLITE_SCHEMA_SOURCE +
  `
export const posts = sqliteTable("posts", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
});
`;

const SQLITE_RENAMED_COLUMN_SCHEMA_SOURCE = `
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey(),
  fullName: text("full_name").notNull(),
});
`;

const stageWorkspace = (initialSource: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectory({
      prefix: "alchemy-drizzle-schema-test-",
    });
    const schemaPath = path.join(root, "schema.ts");
    yield* fs.writeFileString(schemaPath, initialSource);
    const out = path.join(root, "migrations");
    return { root, out, schemaPath };
  });

const readMigrationDirs = (out: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.readDirectory(out))
      .filter((name) => /^\d+_/.test(name))
      .sort();
  });

// Returns snapshots in chain order (each entry's prevIds points at the one
// before it). Directory-name order is NOT reliable: two migrations generated
// within the same second share the timestamp prefix and then sort by the
// random name suffix.
const readSnapshots = (out: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dirs = yield* readMigrationDirs(out);
    const snapshots: Array<{ id: string; prevIds: string[] }> = [];
    for (const dir of dirs) {
      const text = yield* fs.readFileString(
        path.join(out, dir, "snapshot.json"),
      );
      snapshots.push(
        yield* Effect.try({
          try: () => JSON.parse(text) as { id: string; prevIds: string[] },
          catch: (cause) => new Error(`Failed to parse snapshot: ${cause}`),
        }),
      );
    }
    const byPrev = new Map(snapshots.map((s) => [s.prevIds[0], s]));
    const ordered: typeof snapshots = [];
    let cursor = byPrev.get("00000000-0000-0000-0000-000000000000");
    while (cursor !== undefined) {
      ordered.push(cursor);
      cursor = byPrev.get(cursor.id);
    }
    return ordered.length === snapshots.length ? ordered : snapshots;
  });

const getStatus = Effect.fn(function* (fqn: string) {
  const state = yield* yield* State;
  const stk = yield* Stack.Stack;
  const s = yield* state.get({ stack: stk.name, stage: stk.stage, fqn });
  return s?.status;
});

test.provider("initial snapshot starts from the Drizzle origin", (stack) =>
  Effect.gen(function* () {
    const ws = yield* stageWorkspace(SCHEMA_SOURCE);

    yield* stack.deploy(
      Drizzle.Schema("app-schema", {
        schema: ws.schemaPath,
        out: ws.out,
      }),
    );

    const snapshots = yield* readSnapshots(ws.out);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.prevIds).toEqual([DRIZZLE_ORIGIN_UUID]);
  }),
);

test.provider(
  "repeated deploys with no schema drift produce noop, not update (regression: forced update cascaded into Neon.Branch)",
  (stack) =>
    Effect.gen(function* () {
      const ws = yield* stageWorkspace(SCHEMA_SOURCE);

      yield* stack.deploy(
        Drizzle.Schema("app-schema", {
          schema: ws.schemaPath,
          out: ws.out,
        }),
      );
      expect(yield* getStatus("app-schema")).toEqual("created");

      // Second deploy with the same schema. Before the fix, Schema.diff
      // returned `{ action: "update" }` unconditionally, so status would
      // flip to "updated" and downstream resources (e.g. Neon.Branch)
      // would see `schema.out` as an unresolved Output during plan and
      // cascade into their own spurious updates.
      yield* stack.deploy(
        Drizzle.Schema("app-schema", {
          schema: ws.schemaPath,
          out: ws.out,
        }),
      );
      expect(yield* getStatus("app-schema")).toEqual("created");
    }),
);

test.provider(
  "deploy after a real schema change updates the resource",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(SCHEMA_SOURCE);

      const initial = yield* stack.deploy(
        Drizzle.Schema("app-schema", {
          schema: ws.schemaPath,
          out: ws.out,
        }),
      );
      const [initialSnapshot] = yield* readSnapshots(ws.out);

      // Write the drifted schema as a *new* file so the dynamic import
      // cache doesn't hand us the original module.
      const driftedSchemaPath = path.join(ws.root, "schema-drifted.ts");
      yield* fs.writeFileString(driftedSchemaPath, DRIFTED_SCHEMA_SOURCE);
      yield* Effect.sleep("1 second");

      const drifted = yield* stack.deploy(
        Drizzle.Schema("app-schema", {
          schema: driftedSchemaPath,
          out: ws.out,
        }),
      );

      expect(yield* getStatus("app-schema")).toEqual("updated");
      expect(drifted.snapshotHash).not.toEqual(initial.snapshotHash);
      const snapshots = yield* readSnapshots(ws.out);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]?.prevIds).toEqual([initialSnapshot?.id]);
    }),
);

test.provider("list returns [] (non-listable local build artifact)", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const provider = yield* Provider.findProvider(Drizzle.Schema);
    const all = yield* provider.list();
    expect(all).toEqual([]);

    yield* stack.destroy();
  }),
);

test.provider(
  "sqlite schemas generate migrations through the CLI fallback",
  (stack) =>
    Effect.gen(function* () {
      const ws = yield* stageWorkspace(SQLITE_SCHEMA_SOURCE);

      yield* stack.deploy(
        Drizzle.Schema("sqlite-schema", {
          dialect: "sqlite",
          schema: ws.schemaPath,
          out: ws.out,
        }),
      );

      const dirs = yield* readMigrationDirs(ws.out);
      expect(dirs).toHaveLength(1);
      // The CLI owns the real write path for sqlite fallback; it should keep
      // drizzle-kit's generated migration directory names instead of
      // Alchemy's programmatic `<timestamp>_migration` convention.
      expect(dirs[0]).not.toMatch(/_migration$/);

      const snapshots = yield* readSnapshots(ws.out);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.prevIds).toEqual([DRIZZLE_ORIGIN_UUID]);
    }),
);

test.provider(
  "sqlite CLI fallback repeated deploys with no drift stay noop",
  (stack) =>
    Effect.gen(function* () {
      const ws = yield* stageWorkspace(SQLITE_SCHEMA_SOURCE);

      yield* stack.deploy(
        Drizzle.Schema("sqlite-schema", {
          dialect: "sqlite",
          schema: ws.schemaPath,
          out: ws.out,
        }),
      );
      const initialDirs = yield* readMigrationDirs(ws.out);
      expect(yield* getStatus("sqlite-schema")).toEqual("created");

      yield* stack.deploy(
        Drizzle.Schema("sqlite-schema", {
          dialect: "sqlite",
          schema: ws.schemaPath,
          out: ws.out,
        }),
      );

      expect(yield* getStatus("sqlite-schema")).toEqual("created");
      expect(yield* readMigrationDirs(ws.out)).toEqual(initialDirs);
    }),
);

test.provider("sqlite CLI fallback updates after schema drift", (stack) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const ws = yield* stageWorkspace(SQLITE_SCHEMA_SOURCE);

    yield* stack.deploy(
      Drizzle.Schema("sqlite-schema", {
        dialect: "sqlite",
        schema: ws.schemaPath,
        out: ws.out,
      }),
    );
    const [initialSnapshot] = yield* readSnapshots(ws.out);

    const driftedSchemaPath = path.join(ws.root, "schema-sqlite-drifted.ts");
    yield* fs.writeFileString(driftedSchemaPath, SQLITE_DRIFTED_SCHEMA_SOURCE);

    yield* stack.deploy(
      Drizzle.Schema("sqlite-schema", {
        dialect: "sqlite",
        schema: driftedSchemaPath,
        out: ws.out,
      }),
    );

    expect(yield* getStatus("sqlite-schema")).toEqual("updated");
    const dirs = yield* readMigrationDirs(ws.out);
    expect(dirs).toHaveLength(2);
    expect(dirs.every((dir) => !dir.endsWith("_migration"))).toBe(true);

    const snapshots = yield* readSnapshots(ws.out);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.prevIds).toEqual([initialSnapshot?.id]);
  }),
);

test.provider(
  "sqlite CLI fallback refuses ambiguous drift without a TTY",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(SQLITE_SCHEMA_SOURCE);

      yield* stack.deploy(
        Drizzle.Schema("sqlite-schema", {
          dialect: "sqlite",
          schema: ws.schemaPath,
          out: ws.out,
        }),
      );
      const initialDirs = yield* readMigrationDirs(ws.out);

      const renamedSchemaPath = path.join(ws.root, "schema-sqlite-renamed.ts");
      yield* fs.writeFileString(
        renamedSchemaPath,
        SQLITE_RENAMED_COLUMN_SCHEMA_SOURCE,
      );
      yield* Effect.sleep("1 second");

      // A column rename is ambiguous (rename vs drop+create) and the chosen
      // SQL is applied to the real database later in the same deploy, so the
      // non-interactive CLI must fail with guidance instead of deciding.
      const result = yield* Effect.result(
        stack.deploy(
          Drizzle.Schema("sqlite-schema", {
            dialect: "sqlite",
            schema: renamedSchemaPath,
            out: ws.out,
          }),
        ),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain(
          "drizzle-kit needs a decision",
        );
      }
      // No migration was written for the undecided drift.
      expect(yield* readMigrationDirs(ws.out)).toEqual(initialDirs);
    }),
);
