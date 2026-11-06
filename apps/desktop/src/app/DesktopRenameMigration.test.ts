import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

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
      appDataDirectory: root,
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
      appDataDirectory: root,
      explicitHome: Option.none(),
    });
    assert.equal(linked.homePath, legacy);

    const ownedRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ominax-owned-" });
    const ownedLegacy = path.join(ownedRoot, ".t3-learn");
    yield* fs.makeDirectory(ownedLegacy);
    const owned = yield* runMigration({
      homeDirectory: ownedRoot,
      appDataDirectory: ownedRoot,
      explicitHome: Option.none(),
      isHomeOwned: () => Effect.succeed(true),
    });
    assert.equal(owned.homePath, ownedLegacy);
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
      appDataDirectory: root,
      explicitHome: Option.none(),
    });
    assert.equal(existing.homePath, current);

    const configured = yield* runMigration({
      homeDirectory: root,
      appDataDirectory: root,
      explicitHome: Option.some(path.join(root, "configured")),
    });
    assert.equal(configured.homePath, path.join(root, "configured"));
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
