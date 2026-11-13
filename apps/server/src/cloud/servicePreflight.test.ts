import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  BUILD_MIGRATION_HEAD,
  databaseMigrationHead,
} from "../persistence/databaseMigrationHead.ts";
import { migrationManifest } from "../persistence/Migrations.ts";

import { runServicePreflight } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

// regression: #13239 a stale CLI shadowing the updated one kept "updating" to itself
it.each([1])("blocks legacy launcher protocol %i with exact recovery steps", (launcherProtocol) => {
  const result = runServicePreflight({
    databasePath: "/missing/state.sqlite",
    launcherProtocol,
    version: "9.8.7",
  });

  expect(result).toMatchObject({ status: "blocked", version: "9.8.7" });
  const reason = result.status === "blocked" ? result.reason : "";
  expect(reason).toMatch(new RegExp(`\\b${launcherProtocol}\\b`));
  expect(reason).toMatch(new RegExp(`\\b${SERVICE_LAUNCHER_PROTOCOL}\\b`));
  expect(reason).toContain("curl -fsSL https://t3.codes/install.sh | T3CODE_VERSION=9.8.7 sh");
  expect(reason).toContain("~/.local/bin/t3 service install");
  expect(reason).toContain("t3 --version");
  expect(reason).toContain("which -a t3");
});

// regression: #34502 every installed launcher was protocol 3, so protocol 4 blocked every remote update
it.each([3, SERVICE_LAUNCHER_PROTOCOL])(
  "is ready under launcher protocol %i and reports it back",
  (launcherProtocol) => {
    // A released server accepts a ready result only when it names that server's own protocol.
    expect(
      runServicePreflight({
        databasePath: "/missing/state.sqlite",
        launcherProtocol,
        version: "9.8.7",
      }),
    ).toEqual({ status: "ready", version: "9.8.7", launcherProtocol });
  },
);

it.layer(NodeServices.layer)("service preflight database", (it) => {
  it.effect("blocks a database that a newer build migrated", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const databasePath = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-preflight-" }),
        "state.sqlite",
      );
      const db = new NodeSqlite.DatabaseSync(databasePath);
      db.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)");
      const insert = db.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
      for (const [id, name] of migrationManifest) insert.run(id, name);
      const preflight = () =>
        runServicePreflight({ databasePath, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL });

      expect(preflight().status).toBe("ready");
      expect(databaseMigrationHead(databasePath)).toBe(BUILD_MIGRATION_HEAD);

      db.prepare("UPDATE effect_sql_migrations SET name = ? WHERE migration_id = ?").run(
        "ForkMigration",
        BUILD_MIGRATION_HEAD,
      );
      const conflict = preflight();
      expect(conflict.status).toBe("blocked");
      expect(conflict.status === "blocked" ? conflict.reason : "").toContain("ForkMigration");
      db.prepare("UPDATE effect_sql_migrations SET name = ? WHERE migration_id = ?").run(
        migrationManifest.at(-1)![1],
        BUILD_MIGRATION_HEAD,
      );

      // Startup reconciles this V2 preview history, so it must not block an update.
      const preview = path.join(path.dirname(databasePath), "preview.sqlite");
      const previewDb = new NodeSqlite.DatabaseSync(preview);
      previewDb.exec(
        "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)",
      );
      const insertPreview = previewDb.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
      for (const [id, name] of migrationManifest.filter(([id]) => id < 53)) {
        insertPreview.run(id, name);
      }
      insertPreview.run(53, "PullRequestFilesViewed");
      insertPreview.run(54, "OrchestrationV2");
      insertPreview.run(55, "RemoveRedundantProjectionIndexes");
      previewDb.close();
      expect(
        runServicePreflight({ databasePath: preview, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL })
          .status,
      ).toBe("ready");

      const newerId = Math.max(...migrationManifest.map(([id]) => id)) + 1;
      insert.run(newerId, "FromNightly");
      db.close();
      const result = preflight();
      expect(result.status).toBe("blocked");
      expect(result.status === "blocked" ? result.reason : "").toContain(`${newerId}_FromNightly`);
      // Servers report this head, so clients see a database a newer build migrated.
      expect(databaseMigrationHead(databasePath)).toBe(newerId);

      // A database that exists but cannot be read has an unknown history, so it blocks.
      const unreadable = path.join(path.dirname(databasePath), "unreadable.sqlite");
      yield* fs.writeFileString(unreadable, "not a database");
      expect(databaseMigrationHead(unreadable)).toBeUndefined();
      expect(
        runServicePreflight({
          databasePath: unreadable,
          launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        }).status,
      ).toBe("blocked");
      // A missing database is a fresh install.
      expect(databaseMigrationHead(path.join(path.dirname(databasePath), "missing.sqlite"))).toBe(
        BUILD_MIGRATION_HEAD,
      );
    }),
  );
});
