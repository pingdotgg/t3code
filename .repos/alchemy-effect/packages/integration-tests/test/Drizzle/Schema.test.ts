import * as Drizzle from "@alchemy.run/drizzle";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  Interaction,
  type InteractionError,
  type SelectOptions,
  TerminalCancelled,
} from "alchemy/Interaction";
import * as Provider from "alchemy/Provider";
import * as Stack from "alchemy/Stack";
import { isResourceState, State } from "alchemy/State";
import { generate, type GenerateOptions } from "drizzle-kit/cli";
import * as PostgresKit from "drizzle-kit/payload/postgres";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as S from "effect/Schema";

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

const RENAMED_SCHEMA_SOURCE = `
import { pgTable, serial, text } from "drizzle-orm/pg-core";

export const people = pgTable("people", {
  id: serial("id").primaryKey(),
  fullName: text("full_name").notNull(),
});
`;

// The ambient Interaction with `select` answered by `answer`.
const scriptedSelect = Effect.fn(function* (
  answer: (options: SelectOptions<unknown>) => Effect.Effect<unknown, InteractionError>,
) {
  const base = yield* Interaction;
  return Interaction.of({
    ...base,
    prompt: {
      ...base.prompt,
      select: <Value>(options: SelectOptions<Value>) =>
        answer(options) as Effect.Effect<Value, InteractionError>,
    },
  });
});

const stageWorkspace = (initialSource: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Stage inside the repo (not the OS temp dir): the schema module is
    // loaded via dynamic `import()`, and bun resolves its bare
    // `drizzle-orm/*` imports by walking up from the schema file — which
    // only finds `node_modules` when the staging dir lives in the workspace.
    const cwd = yield* Effect.sync(() => process.cwd());
    const tempParent = path.join(cwd, ".alchemy", "tmp");
    yield* fs.makeDirectory(tempParent, { recursive: true });
    const root = yield* fs.makeTempDirectory({
      directory: tempParent,
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
    return (yield* fs.readDirectory(out)).filter((name) => /^\d+_/.test(name)).sort();
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
      const text = yield* fs.readFileString(path.join(out, dir, "snapshot.json"));
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

test.provider(
  "initial snapshot starts from the Drizzle origin",
  (stack) =>
    Effect.gen(function* () {
      const ws = yield* stageWorkspace(SCHEMA_SOURCE);

      yield* stack.deploy(Drizzle.Schema("app-schema", { schema: ws.schemaPath, out: ws.out }));

      const snapshots = yield* readSnapshots(ws.out);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.prevIds).toEqual([DRIZZLE_ORIGIN_UUID]);
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "repeated deploys with no schema drift produce noop, not update (regression: forced update cascaded into Neon.Branch)",
  (stack) =>
    Effect.gen(function* () {
      const ws = yield* stageWorkspace(SCHEMA_SOURCE);

      yield* stack.deploy(Drizzle.Schema("app-schema", { schema: ws.schemaPath, out: ws.out }));
      expect(yield* getStatus("app-schema")).toEqual("created");

      // Second deploy with the same schema. Before the fix, Schema.diff
      // returned `{ action: "update" }` unconditionally, so status would
      // flip to "updated" and downstream resources (e.g. Neon.Branch)
      // would see `schema.out` as an unresolved Output during plan and
      // cascade into their own spurious updates.
      yield* stack.deploy(Drizzle.Schema("app-schema", { schema: ws.schemaPath, out: ws.out }));
      expect(yield* getStatus("app-schema")).toEqual("created");
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "deploy after a real schema change updates the resource",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(SCHEMA_SOURCE);

      const initial = yield* stack.deploy(
        Drizzle.Schema("app-schema", { schema: ws.schemaPath, out: ws.out }),
      );
      const [initialSnapshot] = yield* readSnapshots(ws.out);

      // Write the drifted schema as a *new* file so the dynamic import
      // cache doesn't hand us the original module.
      const driftedSchemaPath = path.join(ws.root, "schema-drifted.ts");
      yield* fs.writeFileString(driftedSchemaPath, DRIFTED_SCHEMA_SOURCE);
      yield* Effect.sleep("1 second");

      const drifted = yield* stack.deploy(
        Drizzle.Schema("app-schema", { schema: driftedSchemaPath, out: ws.out }),
      );

      expect(yield* getStatus("app-schema")).toEqual("updated");
      expect(drifted.snapshotHash).not.toEqual(initial.snapshotHash);
      const snapshots = yield* readSnapshots(ws.out);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]?.prevIds).toEqual([initialSnapshot?.id]);
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "list returns [] (non-listable local build artifact)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(Drizzle.Schema);
      const all = yield* provider.list();
      expect(all).toEqual([]);

      yield* stack.destroy();
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "sqlite schemas generate migrations programmatically",
  (stack) =>
    Effect.gen(function* () {
      const ws = yield* stageWorkspace(SQLITE_SCHEMA_SOURCE);

      yield* stack.deploy(
        Drizzle.Schema("sqlite-schema", { dialect: "sqlite", schema: ws.schemaPath, out: ws.out }),
      );

      const dirs = yield* readMigrationDirs(ws.out);
      expect(dirs).toHaveLength(1);

      const snapshots = yield* readSnapshots(ws.out);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.prevIds).toEqual([DRIZZLE_ORIGIN_UUID]);
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "sqlite repeated deploys with no drift stay noop",
  (stack) =>
    Effect.gen(function* () {
      const ws = yield* stageWorkspace(SQLITE_SCHEMA_SOURCE);

      yield* stack.deploy(
        Drizzle.Schema("sqlite-schema", { dialect: "sqlite", schema: ws.schemaPath, out: ws.out }),
      );
      const initialDirs = yield* readMigrationDirs(ws.out);
      expect(yield* getStatus("sqlite-schema")).toEqual("created");

      yield* stack.deploy(
        Drizzle.Schema("sqlite-schema", { dialect: "sqlite", schema: ws.schemaPath, out: ws.out }),
      );

      expect(yield* getStatus("sqlite-schema")).toEqual("created");
      expect(yield* readMigrationDirs(ws.out)).toEqual(initialDirs);
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "sqlite updates after schema drift",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(SQLITE_SCHEMA_SOURCE);

      yield* stack.deploy(
        Drizzle.Schema("sqlite-schema", { dialect: "sqlite", schema: ws.schemaPath, out: ws.out }),
      );
      const [initialSnapshot] = yield* readSnapshots(ws.out);

      const driftedSchemaPath = path.join(ws.root, "schema-sqlite-drifted.ts");
      yield* fs.writeFileString(driftedSchemaPath, SQLITE_DRIFTED_SCHEMA_SOURCE);
      yield* Effect.sleep("1 second");

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

      const snapshots = yield* readSnapshots(ws.out);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]?.prevIds).toEqual([initialSnapshot?.id]);
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "sqlite refuses ambiguous drift",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(SQLITE_SCHEMA_SOURCE);

      yield* stack.deploy(
        Drizzle.Schema("sqlite-schema", { dialect: "sqlite", schema: ws.schemaPath, out: ws.out }),
      );
      const initialDirs = yield* readMigrationDirs(ws.out);

      const renamedSchemaPath = path.join(ws.root, "schema-sqlite-renamed.ts");
      yield* fs.writeFileString(renamedSchemaPath, SQLITE_RENAMED_COLUMN_SCHEMA_SOURCE);
      yield* Effect.sleep("1 second");

      // A column rename is ambiguous (rename vs drop+create) and the chosen
      // SQL is applied to the real database later in the same deploy, so the
      // deploy must fail with guidance instead of deciding.
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
        expect(String(result.failure)).toContain("needs a decision");
      }
      // No migration was written for the undecided drift.
      expect(yield* readMigrationDirs(ws.out)).toEqual(initialDirs);
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "ambiguous renames are answered through Alchemy's prompts",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(SCHEMA_SOURCE);

      yield* stack.deploy(Drizzle.Schema("app-schema", { schema: ws.schemaPath, out: ws.out }));

      const renamedSchemaPath = path.join(ws.root, "schema-renamed.ts");
      yield* fs.writeFileString(renamedSchemaPath, RENAMED_SCHEMA_SOURCE);
      yield* Effect.sleep("1 second");

      // Answer every rename-or-create question with the offered rename.
      const asked: Array<{ message: string; labels: string[] }> = [];
      const scripted = yield* scriptedSelect((options) =>
        Effect.sync(() => {
          asked.push({
            message: options.message,
            labels: options.options.map((option) => option.label),
          });
          const rename = options.options.find(
            ({ value }) => Predicate.hasProperty(value, "type") && value.type === "rename",
          );
          return (rename ?? options.options[0]!).value;
        }),
      );

      yield* stack
        .deploy(Drizzle.Schema("app-schema", { schema: renamedSchemaPath, out: ws.out }))
        .pipe(Effect.provideService(Interaction, scripted));

      // Table first, then the column inside the already-renamed table.
      expect(asked).toEqual([
        {
          message: "Is table people created or renamed from another table?",
          labels: ["+ people", "~ users › people"],
        },
        {
          message: "Is column people.full_name created or renamed from another column?",
          labels: ["+ people.full_name", "~ people.name › people.full_name"],
        },
      ]);
      const dirs = yield* readMigrationDirs(ws.out);
      expect(dirs).toHaveLength(2);
      const sql = yield* fs.readFileString(path.join(ws.out, dirs[1]!, "migration.sql"));
      expect(sql).toContain('ALTER TABLE "users" RENAME TO "people"');
      expect(sql).toContain('RENAME COLUMN "name" TO "full_name"');
      expect(sql).not.toContain("DROP");
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "cancelling a rename prompt cancels the deploy without writing a migration",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(SCHEMA_SOURCE);

      yield* stack.deploy(Drizzle.Schema("app-schema", { schema: ws.schemaPath, out: ws.out }));
      const initialDirs = yield* readMigrationDirs(ws.out);

      const renamedSchemaPath = path.join(ws.root, "schema-renamed.ts");
      yield* fs.writeFileString(renamedSchemaPath, RENAMED_SCHEMA_SOURCE);

      const scripted = yield* scriptedSelect(() => Effect.fail(new TerminalCancelled()));
      const result = yield* stack
        .deploy(Drizzle.Schema("app-schema", { schema: renamedSchemaPath, out: ws.out }))
        .pipe(Effect.provideService(Interaction, scripted), Effect.result);

      // The CLI exits quietly on a `TerminalCancelled`, so it must reach the
      // caller unwrapped rather than as a generic Error.
      expect(
        Result.isFailure(result) && Predicate.isTagged(result.failure, "TerminalCancelled"),
      ).toBe(true);
      expect(yield* readMigrationDirs(ws.out)).toEqual(initialDirs);
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "renames inside a table moved to another schema are offered, not dropped",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(`
import { pgSchema, serial, text } from "drizzle-orm/pg-core";

export const a = pgSchema("a");
export const b = pgSchema("b");
export const users = a.table("users", { id: serial("id").primaryKey(), old: text("old") });
`);
      yield* stack.deploy(Drizzle.Schema("app-schema", { schema: ws.schemaPath, out: ws.out }));

      const movedSchemaPath = path.join(ws.root, "schema-moved.ts");
      yield* fs.writeFileString(
        movedSchemaPath,
        `
import { pgSchema, serial, text } from "drizzle-orm/pg-core";

export const a = pgSchema("a");
export const b = pgSchema("b");
export const users = b.table("users", { id: serial("id").primaryKey(), new: text("new") });
`,
      );
      yield* Effect.sleep("1 second");

      const asked: Array<Array<string>> = [];
      const scripted = yield* scriptedSelect((options) =>
        Effect.sync(() => {
          asked.push(options.options.map((option) => option.label));
          const rename = options.options.find(
            ({ value }) => Predicate.hasProperty(value, "type") && value.type === "rename",
          );
          return (rename ?? options.options[0]!).value;
        }),
      );
      yield* stack
        .deploy(Drizzle.Schema("app-schema", { schema: movedSchemaPath, out: ws.out }))
        .pipe(Effect.provideService(Interaction, scripted));

      // The column question refers to the moved table; its candidates must
      // follow the table into schema `b`.
      expect(asked).toEqual([
        ["+ b.users", "~ a.users › b.users"],
        ["+ b.users.new", "~ b.users.old › b.users.new"],
      ]);
      const dirs = yield* readMigrationDirs(ws.out);
      const sql = yield* fs.readFileString(path.join(ws.out, dirs[1]!, "migration.sql"));
      expect(sql).toContain('RENAME COLUMN "old" TO "new"');
      expect(sql).not.toContain("DROP");
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "a renamed schema is not offered again as a rename source",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(`
import { pgSchema } from "drizzle-orm/pg-core";

export const a = pgSchema("a");
`);
      yield* stack.deploy(Drizzle.Schema("app-schema", { schema: ws.schemaPath, out: ws.out }));

      const nextSchemaPath = path.join(ws.root, "schema-next.ts");
      yield* fs.writeFileString(
        nextSchemaPath,
        `
import { pgSchema } from "drizzle-orm/pg-core";

export const b = pgSchema("b");
export const c = pgSchema("c");
`,
      );
      yield* Effect.sleep("1 second");

      const asked: Array<Array<string>> = [];
      const scripted = yield* scriptedSelect((options) =>
        Effect.sync(() => {
          asked.push(options.options.map((option) => option.label));
          const rename = options.options.find(
            ({ value }) => Predicate.hasProperty(value, "type") && value.type === "rename",
          );
          return (rename ?? options.options[0]!).value;
        }),
      );
      yield* stack
        .deploy(Drizzle.Schema("app-schema", { schema: nextSchemaPath, out: ws.out }))
        .pipe(Effect.provideService(Interaction, scripted));

      // `a` was consumed by the first answer; offering it again for `c`
      // would hand drizzle-kit an invalid hint.
      expect(asked[0]).toEqual(["+ b", "~ a › b"]);
      expect(
        asked
          .slice(1)
          .flat()
          .some((label) => label.startsWith("~ a")),
      ).toBe(false);
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "a new resource over an existing folder asks its questions during plan",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(SCHEMA_SOURCE);

      // Leave the migrations behind but forget the resource, so the next
      // deploy plans a create.
      yield* stack.deploy(Drizzle.Schema("app-schema", { schema: ws.schemaPath, out: ws.out }));
      yield* stack.destroy();

      const renamedSchemaPath = path.join(ws.root, "schema-renamed.ts");
      yield* fs.writeFileString(renamedSchemaPath, RENAMED_SCHEMA_SOURCE);

      const asked: Array<string> = [];
      const scripted = yield* scriptedSelect((options) =>
        Effect.sync(() => {
          asked.push(options.message);
          return options.options[0]!.value;
        }),
      );
      const plan = yield* stack
        .plan(Drizzle.Schema("app-schema", { schema: renamedSchemaPath, out: ws.out }))
        .pipe(Effect.provideService(Interaction, scripted));

      expect(plan.resources["app-schema"]?.action).toBe("create");
      expect(asked[0]).toEqual("Is table people created or renamed from another table?");
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "an interrupted create is re-driven with the new props",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(SCHEMA_SOURCE);
      yield* stack.deploy(Drizzle.Schema("app-schema", { schema: ws.schemaPath, out: ws.out }));

      // The shape an interrupted first deploy leaves behind.
      const state = yield* yield* State;
      const key = { stack: stack.name, stage: stack.stage, fqn: "app-schema" };
      const row = yield* state.get(key);
      if (!isResourceState(row)) return yield* Effect.die(new Error("no app-schema state row"));
      yield* state.set({
        ...key,
        value: { ...row, props: row.props!, status: "creating", attr: undefined },
      });

      const otherOut = path.join(ws.root, "other-migrations");
      const result = yield* stack.deploy(
        Drizzle.Schema("app-schema", { schema: ws.schemaPath, out: otherOut }),
      );

      expect(path.resolve(result.out)).toEqual(otherOut);
      expect(yield* fs.exists(otherOut)).toBe(true);
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "continues a migrations folder generated by drizzle-kit, and drizzle-kit continues ours",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(SCHEMA_SOURCE);
      const withEmailPath = path.join(ws.root, "schema-email.ts");
      yield* fs.writeFileString(
        withEmailPath,
        SCHEMA_SOURCE.replace(
          'name: text("name").notNull(),',
          'name: text("name").notNull(),\n  email: text("email"),',
        ),
      );
      const kitGenerate = (schema: string) =>
        Effect.promise(() => generate({ dialect: "postgresql", schema, out: ws.out }));

      // drizzle-kit writes a `base` snapshot, then a `diff` snapshot.
      expect((yield* kitGenerate(ws.schemaPath)).status).toEqual("ok");
      yield* Effect.sleep("1 second");
      expect((yield* kitGenerate(withEmailPath)).status).toEqual("ok");

      const driftedPath = path.join(ws.root, "schema-drifted.ts");
      yield* fs.writeFileString(
        driftedPath,
        (yield* fs.readFileString(withEmailPath)) +
          `\nexport const posts = pgTable("posts", {\n  id: serial("id").primaryKey(),\n});\n`,
      );
      yield* Effect.sleep("1 second");
      yield* stack.deploy(Drizzle.Schema("app-schema", { schema: driftedPath, out: ws.out }));

      const dirs = yield* readMigrationDirs(ws.out);
      expect(dirs).toHaveLength(3);
      const sql = yield* fs.readFileString(path.join(ws.out, dirs[2]!, "migration.sql"));
      expect(sql).toContain('CREATE TABLE "posts"');
      expect(sql).not.toContain('"email"');
      // The snapshot Alchemy wrote is one drizzle-kit can build on.
      expect((yield* kitGenerate(driftedPath)).status).toEqual("no_changes");
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "renames after unmerged migration branches are offered from their combined state",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(SCHEMA_SOURCE);
      const kitGenerate = (schema: string, out: string, hints?: GenerateOptions["hints"]) =>
        Effect.promise(() => generate({ dialect: "postgresql", schema, out, hints }));
      const rename = (source: string, to: string) =>
        source.replace('name: text("name")', `name: text("${to}")`);
      const posts = `\nexport const posts = pgTable("posts", {\n  id: serial("id").primaryKey(),\n});\n`;

      // Two branches off one base: one renames `name`, the other adds a table.
      expect((yield* kitGenerate(ws.schemaPath, ws.out)).status).toEqual("ok");
      const branchOut = path.join(ws.root, "branch");
      yield* fs.copy(ws.out, branchOut);
      const fullNamePath = path.join(ws.root, "schema-full-name.ts");
      yield* fs.writeFileString(fullNamePath, rename(SCHEMA_SOURCE, "full_name"));
      const postsPath = path.join(ws.root, "schema-posts.ts");
      yield* fs.writeFileString(postsPath, SCHEMA_SOURCE + posts);
      yield* Effect.sleep("1 second");
      const renamed = yield* kitGenerate(fullNamePath, ws.out, [
        {
          type: "rename",
          kind: "column",
          from: ["public", "users", "name"],
          to: ["public", "users", "full_name"],
        },
      ]);
      expect(renamed.status).toEqual("ok");
      expect((yield* kitGenerate(postsPath, branchOut)).status).toEqual("ok");
      const [, postsDir] = yield* readMigrationDirs(branchOut);
      yield* fs.copy(path.join(branchOut, postsDir!), path.join(ws.out, postsDir!));

      // Both branches merged, with `full_name` renamed again on top.
      const displayNamePath = path.join(ws.root, "schema-display-name.ts");
      yield* fs.writeFileString(displayNamePath, rename(SCHEMA_SOURCE + posts, "display_name"));
      yield* Effect.sleep("1 second");
      const asked: Array<string[]> = [];
      const scripted = yield* scriptedSelect((options) =>
        Effect.sync(() => {
          asked.push(options.options.map((option) => option.label));
          return options.options.at(-1)!.value;
        }),
      );
      yield* stack
        .deploy(Drizzle.Schema("app-schema", { schema: displayNamePath, out: ws.out }))
        .pipe(Effect.provideService(Interaction, scripted));

      // `name` is gone in the combined state, so it is not offered.
      expect(asked).toEqual([["+ users.display_name", "~ users.full_name › users.display_name"]]);
      const dirs = yield* readMigrationDirs(ws.out);
      expect(dirs).toHaveLength(4);
      const sql = yield* fs.readFileString(path.join(ws.out, dirs[3]!, "migration.sql"));
      expect(sql).toContain('RENAME COLUMN "full_name" TO "display_name"');
      expect(sql).not.toContain("DROP");
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "an invalid schema fails the deploy instead of exiting the process",
  (stack) =>
    Effect.gen(function* () {
      const ws = yield* stageWorkspace(
        SQLITE_SCHEMA_SOURCE.replace('name: text("name")', 'name: text("id")'),
      );
      const exit = yield* Effect.sync(() => process.exit);

      const result = yield* Effect.result(
        stack.deploy(
          Drizzle.Schema("sqlite-schema", {
            dialect: "sqlite",
            schema: ws.schemaPath,
            out: ws.out,
          }),
        ),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("found errors in the schema");
      }
      expect(yield* Effect.sync(() => process.exit)).toBe(exit);
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "converts postgres snapshots written by earlier Alchemy versions",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(SCHEMA_SOURCE);

      // Earlier versions wrote each snapshot as a full, untyped `ddl` dump.
      const v1 = yield* Effect.promise(() => import(ws.schemaPath));
      const v2Path = path.join(ws.root, "schema-v2.ts");
      yield* fs.writeFileString(v2Path, DRIFTED_SCHEMA_SOURCE);
      const v2 = yield* Effect.promise(() => import(v2Path));
      const s1 = yield* Effect.promise(() => PostgresKit.generateDrizzleJson(v1));
      const s2 = yield* Effect.promise(() => PostgresKit.generateDrizzleJson(v2, s1.id));
      for (const [dir, snapshot] of [
        ["20260101000000_migration", s1],
        ["20260102000000_migration", s2],
      ] as const) {
        yield* fs.makeDirectory(path.join(ws.out, dir), { recursive: true });
        yield* fs.writeFileString(path.join(ws.out, dir, "migration.sql"), "-- applied\n");
        yield* fs.writeFileString(
          path.join(ws.out, dir, "snapshot.json"),
          JSON.stringify(snapshot, null, 2),
        );
      }

      const v3Path = path.join(ws.root, "schema-v3.ts");
      yield* fs.writeFileString(
        v3Path,
        DRIFTED_SCHEMA_SOURCE +
          `\nexport const tags = pgTable("tags", {\n  id: serial("id").primaryKey(),\n});\n`,
      );
      yield* stack.deploy(Drizzle.Schema("app-schema", { schema: v3Path, out: ws.out }));

      const dirs = yield* readMigrationDirs(ws.out);
      expect(dirs).toHaveLength(3);
      const decodeSnapshot = S.decodeEffect(
        S.fromJsonString(S.Struct({ type: S.optional(S.String) })),
      );
      const types = yield* Effect.forEach(dirs, (dir) =>
        fs.readFileString(path.join(ws.out, dir, "snapshot.json")).pipe(
          Effect.flatMap(decodeSnapshot),
          Effect.map((snapshot) => snapshot.type),
        ),
      );
      expect(types).toEqual(["base", "diff", "diff"]);
      // Applied migrations are untouched; only the new one has SQL to run.
      expect(yield* fs.readFileString(path.join(ws.out, dirs[1]!, "migration.sql"))).toEqual(
        "-- applied\n",
      );
      const sql = yield* fs.readFileString(path.join(ws.out, dirs[2]!, "migration.sql"));
      expect(sql).toContain('CREATE TABLE "tags"');
      expect(sql).not.toContain('"posts"');
      expect(
        (yield* Effect.promise(() =>
          generate({ dialect: "postgresql", schema: v3Path, out: ws.out }),
        )).status,
      ).toEqual("no_changes");
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "migrations generated within the same second keep their own folders",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(SQLITE_SCHEMA_SOURCE);
      const driftedPath = path.join(ws.root, "schema-drifted.ts");
      yield* fs.writeFileString(driftedPath, SQLITE_DRIFTED_SCHEMA_SOURCE);

      yield* stack.deploy(
        Drizzle.Schema("sqlite-schema", { dialect: "sqlite", schema: ws.schemaPath, out: ws.out }),
      );
      yield* stack.deploy(
        Drizzle.Schema("sqlite-schema", { dialect: "sqlite", schema: driftedPath, out: ws.out }),
      );

      const sql = yield* Effect.forEach(yield* readMigrationDirs(ws.out), (dir) =>
        fs.readFileString(path.join(ws.out, dir, "migration.sql")),
      );
      expect(sql).toHaveLength(2);
      expect(sql.some((statements) => statements.includes("CREATE TABLE `users`"))).toBe(true);
      expect(sql.some((statements) => statements.includes("CREATE TABLE `posts`"))).toBe(true);
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "mysql schemas generate migrations programmatically",
  (stack) =>
    Effect.gen(function* () {
      const ws = yield* stageWorkspace(`
import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
});
`);

      yield* stack.deploy(
        Drizzle.Schema("mysql-schema", { dialect: "mysql", schema: ws.schemaPath, out: ws.out }),
      );

      const snapshots = yield* readSnapshots(ws.out);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.prevIds).toEqual([DRIZZLE_ORIGIN_UUID]);
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "generates DSQL-compatible PostgreSQL SQL without a new dialect",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { prepareDsqlStatements } = yield* Effect.promise(
        // Internal to alchemy, so not exported.
        () => import("@alchemy.run/aws/DSQL/MigrationSql"),
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ws = yield* stageWorkspace(`
      import { pgTable, uuid, text, index } from "drizzle-orm/pg-core";
      export const users = pgTable("users", {
        id: uuid("id").primaryKey(), email: text("email").notNull(),
      }, (table) => [index("users_email_idx").on(table.email)]);
    `);
      yield* Effect.gen(function* () {
        yield* stack.deploy(
          Drizzle.Schema("Schema", {
            schema: ws.schemaPath,
            out: ws.out,
            dialect: "postgres",
          }),
        );
        const dirs = yield* readMigrationDirs(ws.out);
        expect(dirs).toHaveLength(1);
        const sql = yield* fs.readFileString(path.join(ws.out, dirs[0], "migration.sql"));
        expect(sql).toContain('"id" uuid PRIMARY KEY');
        const statements = yield* prepareDsqlStatements(sql, dirs[0]);
        expect(statements).toHaveLength(2);
        expect(statements[1]).toContain("INDEX ASYNC");
      }).pipe(
        Effect.ensuring(stack.destroy().pipe(Effect.orDie)),
        Effect.ensuring(fs.remove(ws.root, { recursive: true }).pipe(Effect.orDie)),
      );
    }),
  { tags: ["unit", "local"] },
);
