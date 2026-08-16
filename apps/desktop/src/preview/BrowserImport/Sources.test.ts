import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import {
  BROWSER_IMPORT_SOURCES,
  cookieDatabasePath,
  isSourceInstalled,
  isSourceRunning,
  listSourceProfiles,
  sourcePaths,
} from "./Sources.ts";

const helium = BROWSER_IMPORT_SOURCES.find((source) => source.id === "helium")!;

/** A scratch home with the source's user-data directory already created. */
const withSourceHome = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-sources-" });
  const paths = yield* sourcePaths.pipe(
    Effect.provideService(HostProcessEnvironment, { HOME: home }),
  );
  yield* fileSystem.makeDirectory(helium.userDataDirectory(paths), { recursive: true });
  return paths;
});

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("isSourceRunning", () => {
  it.effect("reads Chromium's dangling SingletonLock symlink as a running browser", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* withSourceHome();
        assert.isFalse(yield* isSourceRunning(helium, paths));

        // Chromium points the lock at `<host>-<pid>`, a target that never
        // exists on disk. A check that follows the link reports a running
        // browser as closed, letting an import read a live, mid-write database.
        yield* fileSystem.symlink(
          "host-that-does-not-exist-1234",
          `${helium.userDataDirectory(paths)}/SingletonLock`,
        );

        assert.isTrue(yield* isSourceRunning(helium, paths));
      }),
    ),
  );
});

describe("isSourceInstalled", () => {
  it.effect("ignores a user-data directory that holds no cookie database", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* withSourceHome();
        const root = helium.userDataDirectory(paths);

        // Installers for native messaging hosts create an empty user-data
        // directory for every Chromium fork they know about, so treating the
        // directory as evidence lists browsers the user does not have.
        yield* fileSystem.makeDirectory(`${root}/NativeMessagingHosts`, { recursive: true });
        assert.isFalse(yield* isSourceInstalled(helium, paths));

        yield* fileSystem.makeDirectory(`${root}/Default`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/Default/Cookies`, "db");
        assert.isTrue(yield* isSourceInstalled(helium, paths));

        yield* fileSystem.remove(root, { recursive: true });
        assert.isFalse(yield* isSourceInstalled(helium, paths));
      }),
    ),
  );
});

describe("listSourceProfiles", () => {
  it.effect("falls back to Default when Local State is absent", () =>
    run(
      Effect.gen(function* () {
        const paths = yield* withSourceHome();
        assert.deepEqual(yield* listSourceProfiles(helium, paths), [
          { directory: "Default", name: "Default" },
        ]);
      }),
    ),
  );

  it.effect("reads the profile names the browser shows", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* withSourceHome();
        yield* fileSystem.writeFileString(
          `${helium.userDataDirectory(paths)}/Local State`,
          `{"profile":{"info_cache":{"Default":{"name":"You"},"Profile 2":{"name":"  "}}}}`,
        );

        assert.deepEqual(yield* listSourceProfiles(helium, paths), [
          { directory: "Default", name: "You" },
          // Blank display name falls back to the directory rather than
          // rendering an empty row.
          { directory: "Profile 2", name: "Profile 2" },
        ]);
      }),
    ),
  );

  it.effect("falls back to Default when Local State is malformed", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* withSourceHome();
        yield* fileSystem.writeFileString(
          `${helium.userDataDirectory(paths)}/Local State`,
          "{not-json",
        );

        assert.deepEqual(yield* listSourceProfiles(helium, paths), [
          { directory: "Default", name: "Default" },
        ]);
      }),
    ),
  );
});

describe("cookieDatabasePath", () => {
  it.effect("places the database under the requested source profile", () =>
    run(
      Effect.gen(function* () {
        const paths = yield* withSourceHome();
        assert.equal(
          cookieDatabasePath(helium, paths, "Profile 1"),
          `${paths.home}/Library/Application Support/net.imput.helium/Profile 1/Cookies`,
        );
      }),
    ),
  );
});
