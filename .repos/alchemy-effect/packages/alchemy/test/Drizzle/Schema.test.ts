import * as Drizzle from "@/Drizzle";
import * as Stack from "@/Stack";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const { test } = Test.make({ providers: Drizzle.providers() });

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

const getStatus = Effect.fn(function* (fqn: string) {
  const state = yield* yield* State;
  const stk = yield* Stack.Stack;
  const s = yield* state.get({ stack: stk.name, stage: stk.stage, fqn });
  return s?.status;
});

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

      // Write the drifted schema as a *new* file so the dynamic import
      // cache doesn't hand us the original module.
      const driftedSchemaPath = path.join(ws.root, "schema-drifted.ts");
      yield* fs.writeFileString(driftedSchemaPath, DRIFTED_SCHEMA_SOURCE);

      const drifted = yield* stack.deploy(
        Drizzle.Schema("app-schema", {
          schema: driftedSchemaPath,
          out: ws.out,
        }),
      );

      expect(yield* getStatus("app-schema")).toEqual("updated");
      expect(drifted.snapshotHash).not.toEqual(initial.snapshotHash);
    }),
);
