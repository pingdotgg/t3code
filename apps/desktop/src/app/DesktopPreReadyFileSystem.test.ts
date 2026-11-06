import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";

import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";
import * as DesktopUserData from "./DesktopUserData.ts";
import { migrateDesktopRename } from "./DesktopRenameMigration.ts";
import * as Option from "effect/Option";

// Only development inspects the filesystem: it reuses a "T3 Code (Dev)" profile when one exists.
const resolveDevelopmentUserData = (appDataDirectory: string) =>
  DesktopUserData.resolveUserDataPath({
    appDataDirectory,
    isDevelopment: true,
    platform: "win32",
  }).pipe(Effect.provide(DesktopPreReadyFileSystem.layer));

it.layer(NodeServices.layer)("DesktopPreReadyFileSystem", (it) => {
  it.effect("runs both rename migrations with the pre-ready filesystem", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pre-ready-migration-" });
      yield* fs.makeDirectory(`${root}/.t3-learn/userdata`, { recursive: true });
      yield* fs.makeDirectory(`${root}/t3learn`, { recursive: true });
      const migration = yield* migrateDesktopRename({
        homeDirectory: root,
        explicitHome: Option.none(),
      }).pipe(Effect.provideService(FileSystem.FileSystem, DesktopPreReadyFileSystem.make));
      const userData = yield* DesktopUserData.resolveUserDataPath({
        appDataDirectory: root,
        isDevelopment: false,
        platform: "linux",
      }).pipe(Effect.provideService(FileSystem.FileSystem, DesktopPreReadyFileSystem.make));
      assert.equal(migration.homePath, `${root}/.ominax`);
      assert.equal(userData, `${root}/ominax`);
      assert.equal(yield* fs.readLink(`${root}/.t3-learn`), `${root}/.ominax`);
      assert.equal(yield* fs.readLink(`${root}/t3learn`), `${root}/ominax`);
    }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "fails instead of treating an unreadable profile as missing",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pre-ready-fs-" });
        yield* fileSystem.chmod(root, 0o000);
        yield* Effect.addFinalizer(() => fileSystem.chmod(root, 0o700).pipe(Effect.orDie));

        const exit = yield* Effect.exit(resolveDevelopmentUserData(root));

        assert.isTrue(Exit.isFailure(exit));
      }),
  );
});
