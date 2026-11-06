import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  migrateDesktopRename,
  migrateElectronUserData,
  type DesktopRenameMigrationInput,
} from "./DesktopRenameMigration.ts";

const runMigration = (input: DesktopRenameMigrationInput) =>
  migrateDesktopRename(input).pipe(Effect.provide(NodeServices.layer));

it.effect("moves the legacy home and links the old path back", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ominax-rename-" });
    const legacy = path.join(root, ".t3-learn");
    const current = path.join(root, ".ominax");
    yield* fs.makeDirectory(path.join(legacy, "userdata"), { recursive: true });

    const result = yield* runMigration({
      homeDirectory: root,
      explicitHome: Option.none(),
      isHomeOwned: () => Effect.succeed(false),
    });

    assert.equal(result.homePath, current);
    assert.equal(yield* fs.readLink(legacy), current);
    assert.equal(yield* fs.stat(current).pipe(Effect.map((info) => info.type)), "Directory");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps a symlinked legacy home and an owned home in place", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ominax-rename-" });
    const legacy = path.join(root, ".t3-learn");
    const target = path.join(root, "elsewhere");
    yield* fs.makeDirectory(target);
    yield* fs.symlink(target, legacy);
    const linked = yield* runMigration({
      homeDirectory: root,
      explicitHome: Option.none(),
    });
    assert.equal(linked.homePath, legacy);

    const ownedRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ominax-owned-" });
    const ownedLegacy = path.join(ownedRoot, ".t3-learn");
    yield* fs.makeDirectory(ownedLegacy);
    const owned = yield* runMigration({
      homeDirectory: ownedRoot,
      explicitHome: Option.none(),
      isHomeOwned: () => Effect.succeed(true),
    });
    assert.equal(owned.homePath, ownedLegacy);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("skips the move while the legacy server owner database is locked", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ominax-owned-lock-" });
    const legacy = path.join(root, ".t3-learn");
    const lockPath = path.join(legacy, "userdata", "server-owner.sqlite");
    yield* fs.makeDirectory(path.dirname(lockPath), { recursive: true });
    const owner = new NodeSqlite.DatabaseSync(lockPath);
    owner.exec("BEGIN EXCLUSIVE");
    try {
      const result = yield* runMigration({
        homeDirectory: root,
        explicitHome: Option.none(),
      });
      assert.equal(result.homePath, legacy);
    } finally {
      owner.exec("ROLLBACK");
      owner.close();
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps an existing OminaX home and honors an explicit override", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ominax-existing-" });
    const current = path.join(root, ".ominax");
    yield* fs.makeDirectory(current);
    const existing = yield* runMigration({
      homeDirectory: root,
      explicitHome: Option.none(),
    });
    assert.equal(existing.homePath, current);
    assert.equal(yield* fs.exists(path.join(root, ".t3-learn")), false);

    const configured = yield* runMigration({
      homeDirectory: root,
      explicitHome: Option.some(path.join(root, "configured")),
    });
    assert.equal(configured.homePath, path.join(root, "configured"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("restores a legacy link only after a moved home loses it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ominax-recover-" });
    const legacy = path.join(root, ".t3-learn");
    const current = path.join(root, ".ominax");
    yield* fs.makeDirectory(legacy);
    yield* fs.writeFileString(path.join(legacy, ".moved-from-t3learn"), "");
    yield* fs.rename(legacy, current);
    const result = yield* runMigration({ homeDirectory: root, explicitHome: Option.none() });
    assert.equal(result.homePath, current);
    assert.equal(yield* fs.readLink(legacy), current);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("moves Electron user data and preserves the legacy link", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ominax-profile-" });
    const legacy = path.join(root, "t3learn");
    const current = path.join(root, "ominax");
    yield* fs.makeDirectory(legacy);
    const result = yield* migrateElectronUserData({
      appDataDirectory: root,
      platform: "linux",
    });

    assert.equal(result, current);
    assert.equal(yield* fs.readLink(legacy), current);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not create a legacy user-data link for a fresh OminaX directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ominax-profile-fresh-" });
    const current = path.join(root, "ominax");
    yield* fs.makeDirectory(current);
    assert.equal(
      yield* migrateElectronUserData({ appDataDirectory: root, platform: "linux" }),
      current,
    );
    assert.equal(yield* fs.exists(path.join(root, "t3learn")), false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("restores a moved Electron user-data link after a crash", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ominax-profile-recover-" });
    const legacy = path.join(root, "t3learn");
    const current = path.join(root, "ominax");
    yield* fs.makeDirectory(legacy);
    yield* fs.writeFileString(path.join(legacy, ".moved-from-t3learn"), "");
    yield* fs.rename(legacy, current);
    assert.equal(
      yield* migrateElectronUserData({ appDataDirectory: root, platform: "linux" }),
      current,
    );
    assert.equal(yield* fs.readLink(legacy), current);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("returns the new path when the link and rollback both fail", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ominax-rollback-" });
    const legacy = path.join(root, ".t3-learn");
    const current = path.join(root, ".ominax");
    yield* fs.makeDirectory(legacy);
    const failure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "rename",
    });
    const brokenFileSystem = {
      ...fs,
      symlink: () => Effect.fail(failure),
      rename: (from: string, to: string) =>
        from === current ? Effect.fail(failure) : fs.rename(from, to),
    } satisfies FileSystem.FileSystem;
    const result = yield* migrateDesktopRename({
      homeDirectory: root,
      explicitHome: Option.none(),
      isHomeOwned: () => Effect.succeed(false),
    }).pipe(Effect.provideService(FileSystem.FileSystem, brokenFileSystem));
    assert.equal(result.homePath, current);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
