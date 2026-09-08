import * as Bundle from "@/Bundle/Bundle";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

layer(NodeServices.layer)("Bundle.build default text module types", (it) => {
  it.effect("inlines a bare .sql import as a string default export", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-sql-module-",
      });
      yield* fs.writeFileString(
        path.join(root, "0000_init.sql"),
        "CREATE TABLE sql_module_marker (id integer primary key);",
      );
      const entry = path.join(root, "entry.ts");
      yield* fs.writeFileString(
        entry,
        `import m0000 from "./0000_init.sql";\nconsole.log(m0000);\n`,
      );

      const result = yield* Bundle.build({
        input: entry,
        cwd: root,
      });

      const code = result.files
        .filter((f) => typeof f.content === "string")
        .map((f) => f.content as string)
        .join("\n");
      expect(code).toContain("CREATE TABLE sql_module_marker");
      // Inlined into the chunk, not emitted as a separate asset.
      expect(result.files.every((f) => !f.path.endsWith(".sql"))).toBe(true);

      yield* fs.remove(root, { recursive: true });
    }),
  );

  it.effect("bundles a drizzle-kit durable-sqlite migrations layout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-drizzle-migrations-",
      });
      // Mirror `drizzle-kit generate` output for `driver: "durable-sqlite"`:
      // migrations.js imports each .sql migration and the meta journal.
      yield* fs.makeDirectory(path.join(root, "drizzle", "meta"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(root, "drizzle", "0000_cool_migration.sql"),
        "CREATE TABLE drizzle_do_marker (id integer primary key, name text);",
      );
      yield* fs.writeFileString(
        path.join(root, "drizzle", "meta", "_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "sqlite",
          entries: [
            {
              idx: 0,
              version: "6",
              when: 1,
              tag: "0000_cool_migration",
              breakpoints: true,
            },
          ],
        }),
      );
      yield* fs.writeFileString(
        path.join(root, "drizzle", "migrations.js"),
        [
          `import journal from './meta/_journal.json';`,
          `import m0000 from './0000_cool_migration.sql';`,
          `export default { journal, migrations: { m0000 } };`,
        ].join("\n"),
      );
      const entry = path.join(root, "entry.ts");
      yield* fs.writeFileString(
        entry,
        `import migrations from "./drizzle/migrations.js";\nconsole.log(migrations);\n`,
      );

      const result = yield* Bundle.build({
        input: entry,
        cwd: root,
      });

      const code = result.files
        .filter((f) => typeof f.content === "string")
        .map((f) => f.content as string)
        .join("\n");
      expect(code).toContain("CREATE TABLE drizzle_do_marker");
      expect(code).toContain("0000_cool_migration");

      yield* fs.remove(root, { recursive: true });
    }),
  );

  it.effect("inlines bare .txt and .html imports as strings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-text-module-",
      });
      yield* fs.writeFileString(
        path.join(root, "note.txt"),
        "TXT_MODULE_MARKER",
      );
      yield* fs.writeFileString(
        path.join(root, "page.html"),
        "<h1>HTML_MODULE_MARKER</h1>",
      );
      const entry = path.join(root, "entry.ts");
      yield* fs.writeFileString(
        entry,
        [
          `import note from "./note.txt";`,
          `import page from "./page.html";`,
          `console.log(note, page);`,
        ].join("\n"),
      );

      const result = yield* Bundle.build({
        input: entry,
        cwd: root,
      });

      const code = result.files
        .filter((f) => typeof f.content === "string")
        .map((f) => f.content as string)
        .join("\n");
      expect(code).toContain("TXT_MODULE_MARKER");
      expect(code).toContain("HTML_MODULE_MARKER");

      yield* fs.remove(root, { recursive: true });
    }),
  );

  it.effect("caller-provided moduleTypes override the defaults", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-module-override-",
      });
      yield* fs.writeFileString(path.join(root, "data.sql"), "OVERRIDE_MARKER");
      const entry = path.join(root, "entry.ts");
      yield* fs.writeFileString(
        entry,
        `import data from "./data.sql";\nconsole.log(data);\n`,
      );

      const result = yield* Bundle.build({
        input: entry,
        cwd: root,
        moduleTypes: { ".sql": "base64" },
      });

      const code = result.files
        .filter((f) => typeof f.content === "string")
        .map((f) => f.content as string)
        .join("\n");
      expect(code).not.toContain("OVERRIDE_MARKER");
      expect(code).toContain(Buffer.from("OVERRIDE_MARKER").toString("base64"));

      yield* fs.remove(root, { recursive: true });
    }),
  );
});
