// @effect-diagnostics nodeBuiltinImport:off - Builds a Chromium-shaped cookie
// table with the same native bindings the source reads.
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  HostProcessEnvironment,
  HostProcessHostname,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeSqlite from "node:sqlite";

import type { BrowserImportPathContext } from "./Sources.ts";
import {
  BROWSER_IMPORT_SOURCES,
  chromiumProcessIsAlive,
  chromiumSingletonLockIsHeld,
  cookieDatabaseCandidatePaths,
  firefoxSymlinkLockIsHeld,
  resolveCookieDatabase,
  isSourceInstalled,
  isSourceRunning,
  isWindowsLockHeldError,
  posixLockIsHeld,
  listSourceProfiles,
  sourcePathContext,
  windowsChromiumCookiesAreHeld,
} from "./Sources.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const helium = BROWSER_IMPORT_SOURCES.find((source) => source.id === "helium")!;

describe("Linux Chromium secret applications", () => {
  it("pins the libsecret application attribute for each supported fork", () => {
    assert.deepEqual(
      Object.fromEntries(
        BROWSER_IMPORT_SOURCES.filter((source) => source.platforms.includes("linux")).map(
          (source) => [source.id, source.linuxSecretApplication],
        ),
      ),
      {
        chrome: "chrome",
        edge: "msedge",
        brave: "brave",
        vivaldi: "vivaldi",
        opera: "opera",
        helium: "chromium",
        firefox: undefined,
      },
    );
  });
});

const platformError = (reasonTag: string): PlatformError.PlatformError =>
  ({ _tag: "PlatformError", reason: { _tag: reasonTag } }) as never;

describe("Windows browser lock errors", () => {
  it("treats sharing and lock violations reported as Busy as held", () => {
    assert.isTrue(isWindowsLockHeldError(platformError("Busy")));
  });

  it("does not treat access denied as proof of an active lock", () => {
    assert.isFalse(isWindowsLockHeldError(platformError("PermissionDenied")));
  });

  it("does not treat a missing lock file as held", () => {
    assert.isFalse(isWindowsLockHeldError(platformError("NotFound")));
  });
});

/** A scratch home with the source's user-data directory already created. */
const withSourceHome = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-sources-" });
  const context = yield* sourcePathContext.pipe(
    Effect.provideService(HostProcessEnvironment, { HOME: home }),
    Effect.provideService(HostProcessPlatform, "darwin"),
  );
  yield* fileSystem.makeDirectory(userDataDirectory(context), { recursive: true });
  return context;
});

/** Every case here runs on darwin, where Helium always resolves a directory. */
const userDataDirectory = (context: BrowserImportPathContext) => {
  const root = helium.userDataDirectory(context);
  if (root === undefined) throw new Error("Helium has no macOS user-data directory");
  return root;
};

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >,
) => effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

/** Writes a Chromium-shaped cookie table with `count` rows. */
const writeCookieDatabase = (file: string, count: number) =>
  Effect.sync(() => {
    const database = new NodeSqlite.DatabaseSync(file);
    database.exec("create table cookies (host_key text, name text)");
    const insert = database.prepare("insert into cookies (host_key, name) values (?, ?)");
    for (let index = 0; index < count; index += 1) insert.run("example.test", `c${index}`);
    database.close();
  });

const writeFirefoxCookieDatabase = (
  file: string,
  defaultContainerCount: number,
  containerCount: number,
) =>
  Effect.sync(() => {
    const database = new NodeSqlite.DatabaseSync(file);
    database.exec("create table moz_cookies (originAttributes text not null)");
    const insert = database.prepare("insert into moz_cookies (originAttributes) values (?)");
    for (let index = 0; index < defaultContainerCount; index += 1) insert.run("");
    for (let index = 0; index < containerCount; index += 1) insert.run("^userContextId=2");
    database.close();
  });

describe("Helium on Linux", () => {
  it.effect.skipIf(!symlinksSupported)("discovers its profiles and checks the user-data lock", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-helium-linux-" });
        const context = yield* sourcePathContext.pipe(
          Effect.provideService(HostProcessEnvironment, { HOME: home }),
          Effect.provideService(HostProcessPlatform, "linux"),
        );
        const root = `${home}/.config/net.imput.helium`;
        yield* fileSystem.makeDirectory(`${root}/Default`, { recursive: true });
        yield* writeCookieDatabase(`${root}/Default/Cookies`, 3);
        yield* fileSystem.writeFileString(
          `${root}/Local State`,
          '{"profile":{"info_cache":{"Default":{"name":"Personal"}}}}',
        );

        assert.include(helium.platforms, "linux");
        assert.isTrue(yield* isSourceInstalled(helium, context));
        assert.deepEqual(yield* listSourceProfiles(helium, context), [
          { directory: "Default", name: "Personal", cookieCount: 3 },
        ]);
        assert.isFalse(yield* isSourceRunning(helium, context));
        yield* fileSystem.symlink("foreign-host-4242", `${root}/SingletonLock`);
        assert.isTrue(yield* isSourceRunning(helium, context));
      }),
    ),
  );
});

describe("Helium on Windows", () => {
  it.effect("uses Helium's local app-data profile while other Chromium forks stay disabled", () =>
    run(
      Effect.gen(function* () {
        const context = yield* sourcePathContext.pipe(
          Effect.provideService(HostProcessEnvironment, {
            USERPROFILE: "C:\\Users\\browser-user",
            LOCALAPPDATA: "C:\\Users\\browser-user\\AppData\\Local",
          }),
          Effect.provideService(HostProcessPlatform, "win32"),
        );

        assert.include(helium.platforms, "win32");
        assert.equal(
          helium.userDataDirectory(context),
          context.path.join(
            "C:\\Users\\browser-user\\AppData\\Local",
            "imput",
            "Helium",
            "User Data",
          ),
        );
        for (const source of BROWSER_IMPORT_SOURCES) {
          if (source.engine === "chromium" && source.id !== "helium") {
            assert.notInclude(source.platforms, "win32");
          }
        }
      }),
    ),
  );
});

describe("isSourceRunning", () => {
  it.effect("uses the held cookie database as Chromium's Windows running signal", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-helium-windows-lock-",
        });
        const context = yield* sourcePathContext.pipe(
          Effect.provideService(HostProcessEnvironment, {
            HOME: home,
            LOCALAPPDATA: home,
          }),
          Effect.provideService(HostProcessPlatform, "win32"),
        );
        const profile = context.path.join(helium.userDataDirectory(context)!, "Default");
        const database = context.path.join(profile, "Network", "Cookies");
        yield* fileSystem.makeDirectory(context.path.join(profile, "Network"), { recursive: true });
        yield* writeCookieDatabase(database, 1);

        const probed: string[] = [];
        assert.isTrue(
          yield* windowsChromiumCookiesAreHeld(helium, context, (path) =>
            Effect.sync(() => {
              probed.push(path);
              return true;
            }),
          ),
        );
        assert.deepEqual(probed, [database]);
      }),
    ),
  );

  it.effect.skipIf(!symlinksSupported)(
    "reads Chromium's dangling SingletonLock symlink as a running browser",
    () =>
      run(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const context = yield* withSourceHome();
          assert.isFalse(yield* isSourceRunning(helium, context));

          // Chromium points the lock at `<host>-<pid>`, a target that never
          // exists on disk. A check that follows the link reports a running
          // browser as closed, letting an import read a live, mid-write database.
          yield* fileSystem.symlink(
            "host-that-does-not-exist-1234",
            `${userDataDirectory(context)}/SingletonLock`,
          );

          assert.isTrue(yield* isSourceRunning(helium, context));
        }),
      ),
  );

  it.effect.skipIf(!symlinksSupported)(
    "uses the provided hostname to classify Chromium locks",
    () =>
      run(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* withSourceHome();
          yield* fileSystem.symlink(
            "lock-owner-99999999",
            `${helium.userDataDirectory(paths)}/SingletonLock`,
          );

          assert.isTrue(
            yield* isSourceRunning(helium, paths).pipe(
              Effect.provideService(HostProcessHostname, "another-host"),
            ),
          );
          assert.isFalse(
            yield* isSourceRunning(helium, paths).pipe(
              Effect.provideService(HostProcessHostname, "lock-owner"),
            ),
          );
        }),
      ),
  );
});

describe("chromiumSingletonLockIsHeld", () => {
  it.effect("ignores a positively dead PID on the current host", () =>
    Effect.gen(function* () {
      const checked: number[] = [];
      const held = yield* chromiumSingletonLockIsHeld("current-host-4321", "current-host", (pid) =>
        Effect.sync(() => {
          checked.push(pid);
          return false;
        }),
      );
      assert.isFalse(held);
      assert.deepEqual(checked, [4321]);
    }),
  );

  it.effect("keeps a live PID on the current host", () =>
    chromiumSingletonLockIsHeld("current-host-4321", "current-host", () =>
      Effect.succeed(true),
    ).pipe(Effect.tap((held) => Effect.sync(() => assert.isTrue(held)))),
  );

  it.effect("keeps foreign-host and malformed targets without probing a PID", () =>
    Effect.gen(function* () {
      let probes = 0;
      const probe = (_pid: number) =>
        Effect.sync(() => {
          probes += 1;
          return false;
        });
      assert.isTrue(yield* chromiumSingletonLockIsHeld("another-host-4321", "current-host", probe));
      assert.isTrue(
        yield* chromiumSingletonLockIsHeld("current-host-no-pid", "current-host", probe),
      );
      assert.isTrue(yield* chromiumSingletonLockIsHeld("current-host-0", "current-host", probe));
      assert.strictEqual(probes, 0);
    }),
  );
});

describe("chromiumProcessIsAlive", () => {
  it.effect("returns false only when signal 0 reports a missing process", () =>
    Effect.gen(function* () {
      const missing = Object.assign(new Error("missing"), { code: "ESRCH" });
      const denied = Object.assign(new Error("denied"), { code: "EPERM" });
      assert.isFalse(
        yield* chromiumProcessIsAlive(4321, () => {
          throw missing;
        }),
      );
      assert.isTrue(
        yield* chromiumProcessIsAlive(4321, () => {
          throw denied;
        }),
      );
      assert.isTrue(
        yield* chromiumProcessIsAlive(4321, () => {
          throw undefined;
        }),
      );
      assert.isTrue(
        yield* chromiumProcessIsAlive(4321, () => {
          throw "unknown failure";
        }),
      );
      assert.isTrue(
        yield* chromiumProcessIsAlive(4321, () => {
          throw null;
        }),
      );
      assert.isTrue(yield* chromiumProcessIsAlive(4321, () => true));
    }),
  );
});

describe("isSourceInstalled", () => {
  it.effect("ignores a user-data directory that holds no cookie database", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        const root = userDataDirectory(context);

        // Installers for native messaging hosts create an empty user-data
        // directory for every Chromium fork they know about, so treating the
        // directory as evidence lists browsers the user does not have.
        yield* fileSystem.makeDirectory(`${root}/NativeMessagingHosts`, { recursive: true });
        assert.isFalse(yield* isSourceInstalled(helium, context));

        yield* fileSystem.makeDirectory(`${root}/Default`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/Default/Cookies`, "db");
        assert.isTrue(yield* isSourceInstalled(helium, context));

        // A real install whose cookies live outside `Default` still counts:
        // reporting it as absent hides the source from the menu entirely.
        yield* fileSystem.remove(`${root}/Default`, { recursive: true });
        yield* fileSystem.makeDirectory(`${root}/Profile 1`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/Profile 1/Cookies`, "db");
        assert.isTrue(yield* isSourceInstalled(helium, context));

        yield* fileSystem.remove(root, { recursive: true });
        assert.isFalse(yield* isSourceInstalled(helium, context));
      }),
    ),
  );

  it.effect("detects a Chromium 127+ install with cookies under Network/", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        const root = userDataDirectory(context);

        yield* fileSystem.makeDirectory(`${root}/Default/Network`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/Default/Network/Cookies`, "db");
        assert.isTrue(yield* isSourceInstalled(helium, context));
      }),
    ),
  );

  it.effect.skipIf(!symlinksSupported)(
    "follows cookie database symlinks when detecting profiles",
    () =>
      run(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const context = yield* withSourceHome();
          const root = userDataDirectory(context);
          yield* fileSystem.makeDirectory(`${root}/Default`, { recursive: true });
          yield* fileSystem.symlink("missing-cookies", `${root}/Default/Cookies`);

          assert.deepEqual(yield* listSourceProfiles(helium, context), []);
          assert.isFalse(yield* isSourceInstalled(helium, context));

          yield* fileSystem.writeFileString(`${root}/Default/missing-cookies`, "db");
          assert.deepEqual(yield* listSourceProfiles(helium, context), [
            { directory: "Default", name: "Default" },
          ]);
          assert.isTrue(yield* isSourceInstalled(helium, context));
        }),
      ),
  );
});

describe("listSourceProfiles", () => {
  it.effect("ignores a profile whose Cookies entry is not a file", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* withSourceHome();
        const root = helium.userDataDirectory(paths);
        // A directory named `Cookies` would list as importable and then fail
        // the SQLite open, so only a regular file counts as a database.
        yield* fileSystem.makeDirectory(`${root}/Broken/Cookies`, { recursive: true });
        yield* fileSystem.makeDirectory(`${root}/Real`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/Real/Cookies`, "db");

        assert.deepEqual(yield* listSourceProfiles(helium, paths), [
          { directory: "Real", name: "Real" },
        ]);
        assert.isTrue(yield* isSourceInstalled(helium, paths));
      }),
    ),
  );

  it.effect("discovers profiles by their cookie database when Local State is absent", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        const root = userDataDirectory(context);
        // Assuming `Default` would report a browser whose cookies live in
        // `Profile 1` as having nothing to import, and it is then hidden.
        yield* fileSystem.makeDirectory(`${root}/Profile 1`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/Profile 1/Cookies`, "db");
        yield* fileSystem.makeDirectory(`${root}/NativeMessagingHosts`, { recursive: true });

        assert.deepEqual(yield* listSourceProfiles(helium, context), [
          { directory: "Profile 1", name: "Profile 1" },
        ]);
      }),
    ),
  );

  it.effect("reads the profile names the browser shows", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        yield* fileSystem.writeFileString(
          `${userDataDirectory(context)}/Local State`,
          `{"profile":{"info_cache":{"Default":{"name":"You"},"Profile 2":{"name":"  "}}}}`,
        );

        assert.deepEqual(yield* listSourceProfiles(helium, context), [
          { directory: "Default", name: "You" },
          // Blank display name falls back to the directory rather than
          // rendering an empty row.
          { directory: "Profile 2", name: "Profile 2" },
        ]);
      }),
    ),
  );

  it.effect("scans for profiles when Local State is malformed", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        const root = userDataDirectory(context);
        yield* fileSystem.writeFileString(`${root}/Local State`, "{not-json");
        yield* fileSystem.makeDirectory(`${root}/Default`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/Default/Cookies`, "db");

        assert.deepEqual(yield* listSourceProfiles(helium, context), [
          { directory: "Default", name: "Default" },
        ]);
      }),
    ),
  );

  it.effect("reports nothing when no directory holds a cookie database", () =>
    run(
      Effect.gen(function* () {
        const context = yield* withSourceHome();
        assert.deepEqual(yield* listSourceProfiles(helium, context), []);
      }),
    ),
  );

  it.effect("drops Firefox profiles that hold no cookie database", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        const root = firefox.userDataDirectory(context)!;
        yield* fileSystem.makeDirectory(root, { recursive: true });
        yield* fileSystem.writeFileString(
          `${root}/profiles.ini`,
          `[Profile0]
Name=original
IsRelative=1
Path=Profiles/abcd.default-release
Default=1

[Profile1]
Name=empty
IsRelative=1
Path=Profiles/wxyz.empty
`,
        );
        yield* fileSystem.makeDirectory(`${root}/Profiles/abcd.default-release`, {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          `${root}/Profiles/abcd.default-release/cookies.sqlite`,
          "db",
        );
        yield* fileSystem.makeDirectory(`${root}/Profiles/wxyz.empty`, { recursive: true });

        assert.deepEqual(yield* listSourceProfiles(firefox, context), [
          { directory: context.path.join("Profiles", "abcd.default-release"), name: "original" },
        ]);
      }),
    ),
  );

  it.effect("drops empty profiles when falling back to the Profiles/ scan", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        const root = firefox.userDataDirectory(context)!;
        yield* fileSystem.makeDirectory(`${root}/Profiles/filled.default`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/Profiles/filled.default/cookies.sqlite`, "db");
        yield* fileSystem.makeDirectory(`${root}/Profiles/empty.default`, { recursive: true });

        assert.deepEqual(yield* listSourceProfiles(firefox, context), [
          {
            directory: context.path.join("Profiles", "filled.default"),
            name: "filled.default",
          },
        ]);
      }),
    ),
  );

  it.effect("discovers profiles with cookies under Network/ (Chromium 127+)", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        const root = userDataDirectory(context);
        yield* fileSystem.makeDirectory(`${root}/Default/Network`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/Default/Network/Cookies`, "db");

        assert.deepEqual(yield* listSourceProfiles(helium, context), [
          { directory: "Default", name: "Default" },
        ]);
      }),
    ),
  );

  it.effect("counts a profile's cookies without decrypting them", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* withSourceHome();
        const root = helium.userDataDirectory(paths);
        yield* fileSystem.makeDirectory(`${root}/Default`, { recursive: true });
        yield* writeCookieDatabase(`${root}/Default/Cookies`, 3);

        const [profile] = yield* listSourceProfiles(helium, paths);
        assert.equal(profile?.cookieCount, 3);
      }),
    ),
  );

  it.effect("falls through to the legacy database when Network/Cookies is a directory", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* withSourceHome();
        const root = helium.userDataDirectory(paths);
        // A folder squatting on the preferred candidate path must not shadow
        // the real legacy database behind it.
        yield* fileSystem.makeDirectory(`${root}/Default/Network/Cookies`, { recursive: true });
        yield* writeCookieDatabase(`${root}/Default/Cookies`, 2);

        const [profile] = yield* listSourceProfiles(helium, paths);
        assert.equal(profile?.directory, "Default");
        assert.equal(profile?.cookieCount, 2);
      }),
    ),
  );
});

describe("cookieDatabaseCandidatePaths", () => {
  it.effect("prefers Network/Cookies and falls back to the legacy Cookies", () =>
    run(
      Effect.gen(function* () {
        const context = yield* withSourceHome();
        const profile = context.path.join(
          context.home,
          "Library",
          "Application Support",
          "net.imput.helium",
          "Profile 1",
        );
        assert.deepEqual(cookieDatabaseCandidatePaths(helium, context, "Profile 1"), [
          context.path.join(profile, "Network", "Cookies"),
          context.path.join(profile, "Cookies"),
        ]);
      }),
    ),
  );

  it.effect("resolves the live Network/ jar over a leftover root Cookies", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        const root = userDataDirectory(context);
        // Chromium 96+ keeps sessions in Network/; a root Cookies left behind
        // by the move is stale and must not be the one imported.
        yield* fileSystem.makeDirectory(`${root}/Default/Network`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/Default/Network/Cookies`, "live");
        yield* fileSystem.writeFileString(`${root}/Default/Cookies`, "stale");

        assert.equal(
          yield* resolveCookieDatabase(helium, context, "Default"),
          context.path.join(root, "Default", "Network", "Cookies"),
        );
        // A fresh install with only the Network/ jar is installed, not hidden.
        yield* fileSystem.remove(`${root}/Default/Cookies`);
        assert.isTrue(yield* isSourceInstalled(helium, context));
      }),
    ),
  );

  it.effect("returns only cookies.sqlite for Firefox", () =>
    run(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const context = yield* sourcePathContext.pipe(
          Effect.provideService(HostProcessEnvironment, { HOME: "/tmp/test" }),
          Effect.provideService(HostProcessPlatform, "darwin"),
        );
        const candidates = cookieDatabaseCandidatePaths(firefox, context, "Profiles/abc.default");
        assert.deepEqual(candidates, [
          path.join(
            "/tmp/test",
            "Library/Application Support/Firefox/Profiles/abc.default/cookies.sqlite",
          ),
        ]);
      }),
    ),
  );
});

const firefox = BROWSER_IMPORT_SOURCES.find((source) => source.id === "firefox")!;

describe("Firefox Snap profiles", () => {
  it.effect.skipIf(!symlinksSupported)(
    "finds Snap profiles with or without profiles.ini and checks their locks",
    () =>
      run(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const home = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3code-firefox-snap-",
          });
          const context = yield* sourcePathContext.pipe(
            Effect.provideService(HostProcessEnvironment, { HOME: home }),
            Effect.provideService(HostProcessPlatform, "linux"),
          );
          const root = context.path.join(home, "snap", "firefox", "common", ".mozilla", "firefox");
          const directory = context.path.join(root, "abcd.default");
          yield* fileSystem.makeDirectory(directory, { recursive: true });
          yield* writeFirefoxCookieDatabase(`${directory}/cookies.sqlite`, 2, 1);
          yield* fileSystem.writeFileString(
            `${root}/profiles.ini`,
            "[Profile0]\nName=Personal\nIsRelative=1\nPath=abcd.default\n",
          );

          assert.isTrue(yield* isSourceInstalled(firefox, context));
          assert.deepEqual(yield* listSourceProfiles(firefox, context), [
            { directory, name: "Personal", cookieCount: 2 },
          ]);
          assert.equal(
            yield* resolveCookieDatabase(firefox, context, directory),
            context.path.join(directory, "cookies.sqlite"),
          );
          assert.isFalse(yield* isSourceRunning(firefox, context));
          yield* fileSystem.symlink("foreign-host:+4242", `${directory}/lock`);
          assert.isTrue(yield* isSourceRunning(firefox, context));
          yield* fileSystem.remove(`${directory}/lock`);
          assert.isFalse(yield* isSourceRunning(firefox, context));

          yield* fileSystem.remove(`${root}/profiles.ini`);
          assert.deepEqual(yield* listSourceProfiles(firefox, context), [
            { directory, name: "abcd.default", cookieCount: 2 },
          ]);
        }),
      ),
  );

  it.effect("keeps matching profile names in native and Snap installs distinct", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-firefox-snap-" });
        const context = yield* sourcePathContext.pipe(
          Effect.provideService(HostProcessEnvironment, { HOME: home }),
          Effect.provideService(HostProcessPlatform, "linux"),
        );
        const native = context.path.join(home, ".mozilla", "firefox");
        const snap = context.path.join(home, "snap", "firefox", "common", ".mozilla", "firefox");
        for (const root of [native, snap]) {
          yield* fileSystem.makeDirectory(`${root}/abcd.default`, { recursive: true });
          yield* writeFirefoxCookieDatabase(`${root}/abcd.default/cookies.sqlite`, 1, 0);
          yield* fileSystem.writeFileString(
            `${root}/profiles.ini`,
            "[Profile0]\nName=Personal\nIsRelative=1\nPath=abcd.default\n" +
              `[Profile1]\nName=Shared\nIsRelative=0\nPath=${snap}/abcd.default\n`,
          );
        }

        const profiles = yield* listSourceProfiles(firefox, context);
        assert.deepEqual(
          profiles.map((profile) => profile.directory),
          ["abcd.default", context.path.join(snap, "abcd.default")],
        );
        const databases = yield* Effect.forEach(profiles, (profile) =>
          resolveCookieDatabase(firefox, context, profile.directory),
        );
        assert.deepEqual(databases, [
          context.path.join(native, "abcd.default", "cookies.sqlite"),
          context.path.join(snap, "abcd.default", "cookies.sqlite"),
        ]);
      }),
    ),
  );
});

describe("listSourceProfiles Firefox fallback", () => {
  const cases = [
    { platform: "linux" as const, profileDirectory: "linux.default" },
    { platform: "darwin" as const, profileDirectory: NodePath.join("Profiles", "macos.default") },
    { platform: "win32" as const, profileDirectory: NodePath.join("Profiles", "windows.default") },
  ];

  for (const { platform, profileDirectory } of cases) {
    it.effect(`scans the ${platform} profile location and excludes stale entries`, () =>
      run(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fileSystem.makeTempDirectoryScoped({
            prefix: `t3code-firefox-${platform}-`,
          });
          const appData = path.join(home, "AppData", "Roaming");
          const context = yield* sourcePathContext.pipe(
            Effect.provideService(HostProcessEnvironment, {
              HOME: home,
              APPDATA: appData,
            }),
            Effect.provideService(HostProcessPlatform, platform),
          );
          const root = firefox.userDataDirectory(context)!;
          const scanRoot = platform === "linux" ? root : path.join(root, "Profiles");
          yield* fileSystem.makeDirectory(path.join(root, profileDirectory), { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(root, profileDirectory, "cookies.sqlite"),
            "db",
          );
          yield* fileSystem.makeDirectory(path.join(scanRoot, "stale.default"), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(path.join(scanRoot, "stale-file.default"), "not-dir");

          assert.deepEqual(yield* listSourceProfiles(firefox, context), [
            {
              directory: profileDirectory,
              name: path.basename(profileDirectory),
            },
          ]);
        }),
      ),
    );
  }

  it.effect("scans for profiles when profiles.ini declares only ones without cookies", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-firefox-stale-ini-",
        });
        const context = yield* sourcePathContext.pipe(
          Effect.provideService(HostProcessEnvironment, { HOME: home }),
          Effect.provideService(HostProcessPlatform, "darwin"),
        );
        const root = firefox.userDataDirectory(context)!;
        // `profiles.ini` names a profile that was never launched (no cookie
        // database), while the real cookies sit in an undeclared one.
        yield* fileSystem.makeDirectory(path.join(root, "Profiles", "stale.default"), {
          recursive: true,
        });
        const realDirectory = path.join(root, "Profiles", "real.default");
        yield* fileSystem.makeDirectory(realDirectory, { recursive: true });
        yield* writeFirefoxCookieDatabase(path.join(realDirectory, "cookies.sqlite"), 3, 0);
        yield* fileSystem.writeFileString(
          path.join(root, "profiles.ini"),
          ["[Profile0]", "Name=Stale", "IsRelative=1", "Path=Profiles/stale.default"].join("\n"),
        );

        // Returning the empty declared list would hide the browser entirely.
        assert.deepEqual(yield* listSourceProfiles(firefox, context), [
          {
            directory: path.join("Profiles", "real.default"),
            name: "real.default",
            cookieCount: 3,
          },
        ]);
        assert.isTrue(yield* isSourceInstalled(firefox, context));
      }),
    ),
  );

  it.effect("counts only importable cookies for declared and fallback profiles", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-firefox-counts-",
        });
        const context = yield* sourcePathContext.pipe(
          Effect.provideService(HostProcessEnvironment, { HOME: home }),
          Effect.provideService(HostProcessPlatform, "darwin"),
        );
        const root = firefox.userDataDirectory(context)!;
        const declaredDirectory = path.join(root, "Profiles", "declared.default");
        yield* fileSystem.makeDirectory(declaredDirectory, { recursive: true });
        yield* writeFirefoxCookieDatabase(path.join(declaredDirectory, "cookies.sqlite"), 2, 3);
        yield* fileSystem.writeFileString(
          path.join(root, "profiles.ini"),
          ["[Profile0]", "Name=Declared", "IsRelative=1", "Path=Profiles/declared.default"].join(
            "\n",
          ),
        );

        assert.deepEqual(yield* listSourceProfiles(firefox, context), [
          {
            directory: path.join("Profiles", "declared.default"),
            name: "Declared",
            cookieCount: 2,
          },
        ]);

        yield* fileSystem.remove(path.join(root, "profiles.ini"));
        const fallbackDirectory = path.join(root, "Profiles", "fallback.default");
        yield* fileSystem.makeDirectory(fallbackDirectory, { recursive: true });
        yield* writeFirefoxCookieDatabase(path.join(fallbackDirectory, "cookies.sqlite"), 1, 4);

        assert.deepEqual(yield* listSourceProfiles(firefox, context), [
          {
            directory: path.join("Profiles", "declared.default"),
            name: "declared.default",
            cookieCount: 2,
          },
          {
            directory: path.join("Profiles", "fallback.default"),
            name: "fallback.default",
            cookieCount: 1,
          },
        ]);
      }),
    ),
  );
});

describe("isSourceRunning for Firefox", () => {
  it.effect.skipIf(!symlinksSupported)("finds the lock inside the profile, not at the root", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-firefox-" });
        const context = yield* sourcePathContext.pipe(
          Effect.provideService(HostProcessEnvironment, { HOME: home }),
          Effect.provideService(HostProcessPlatform, "darwin"),
        );
        const root = firefox.userDataDirectory(context)!;
        const profile = `${root}/Profiles/abcd.default-release`;
        yield* fileSystem.makeDirectory(profile, { recursive: true });
        yield* fileSystem.writeFileString(`${profile}/cookies.sqlite`, "db");

        assert.isFalse(yield* isSourceRunning(firefox, context));

        // Firefox keeps its locks per profile. A root-level lock is not one,
        // and looking there was why a running Firefox read as importable.
        yield* fileSystem.writeFileString(`${root}/lock`, "");
        assert.isFalse(yield* isSourceRunning(firefox, context));

        // `.parentlock` is deliberately left on disk after a clean exit as a
        // last-used marker, so an unlocked one is not evidence of a running
        // browser — treating it as one blocked every import after first use.
        yield* fileSystem.writeFileString(`${profile}/.parentlock`, "");
        assert.isFalse(yield* isSourceRunning(firefox, context));

        // The `lock` symlink is what Firefox removes on exit; a live pid in
        // its target means the profile is held.
        yield* fileSystem.symlink(`127.0.0.1:+${process.pid}`, `${profile}/lock`);
        assert.isTrue(yield* isSourceRunning(firefox, context));
      }),
    ),
  );

  it.effect("reports not-held when no interpreter can run the fcntl probe", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-lock-" });
        const lock = `${directory}/.parentlock`;
        yield* fileSystem.writeFileString(lock, "");
        // A Mac without the developer tools has only Apple's shim, which
        // refuses to run the script; a machine with no python at all has
        // nothing. Either way the probe is unavailable, not the lock held —
        // treating it as held would block Firefox import on that machine for
        // good.
        assert.isFalse(yield* posixLockIsHeld(lock, ["/nonexistent/python3"]));
        // And a fake "interpreter" that exits non-zero without a verdict, as
        // the shim does, is the same case.
        assert.isFalse(yield* posixLockIsHeld(lock, ["/usr/bin/false"]));
      }),
    ),
  );

  // Holds the lock with python3's fcntl, which does not exist on Windows.
  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "detects a live fcntl lock on .parentlock, as macOS Firefox leaves it",
    () =>
      run(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-firefox-" });
          const context = yield* sourcePathContext.pipe(
            Effect.provideService(HostProcessEnvironment, { HOME: home }),
            Effect.provideService(HostProcessPlatform, "darwin"),
          );
          const root = firefox.userDataDirectory(context)!;
          const profile = `${root}/Profiles/abcd.default-release`;
          yield* fileSystem.makeDirectory(profile, { recursive: true });
          yield* fileSystem.writeFileString(`${profile}/cookies.sqlite`, "db");
          const parentLock = `${profile}/.parentlock`;
          yield* fileSystem.writeFileString(parentLock, "");

          // Hold the lock from a child the way Firefox does (F_SETLK, write),
          // and keep it until the scope closes.
          const holder = yield* spawner.spawn(
            ChildProcess.make(
              "python3",
              [
                "-c",
                "import fcntl,os,sys,time\n" +
                  "fd=os.open(sys.argv[1],os.O_WRONLY)\n" +
                  "fcntl.lockf(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)\n" +
                  "print('locked',flush=True)\n" +
                  "time.sleep(30)",
                parentLock,
              ],
              { stdin: "ignore" },
            ),
          );
          // Wait for the child to confirm it holds the lock before probing.
          yield* holder.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.filter((line) => line.trim() === "locked"),
            Stream.take(1),
            Stream.runDrain,
          );

          assert.isTrue(yield* isSourceRunning(firefox, context));
          yield* holder.kill();
        }),
      ),
  );

  it.effect("reads a Firefox lock symlink's pid to tell live from crashed", () =>
    Effect.gen(function* () {
      const alive = (pid: number) => Effect.succeed(pid === 4242);
      // The resolver may hand Firefox any of the machine's addresses, not
      // just 127.0.0.1 — 127.0.1.1 on Debian-style hosts, a LAN address
      // elsewhere — so every local address counts as ours.
      const local = new Set(["127.0.0.1", "127.0.1.1", "192.168.1.20"]);
      // Both the plain and the fcntl-marked (`+`) forms carry the pid.
      assert.isTrue(yield* firefoxSymlinkLockIsHeld("127.0.0.1:4242", local, alive));
      assert.isTrue(yield* firefoxSymlinkLockIsHeld("127.0.1.1:+4242", local, alive));
      assert.isTrue(yield* firefoxSymlinkLockIsHeld("192.168.1.20:+4242", local, alive));
      // A crash leaves the symlink behind with a dead pid, on any local address.
      assert.isFalse(yield* firefoxSymlinkLockIsHeld("127.0.0.1:+9999", local, alive));
      assert.isFalse(yield* firefoxSymlinkLockIsHeld("192.168.1.20:+9999", local, alive));
      // Anything unparseable stays conservative.
      assert.isTrue(yield* firefoxSymlinkLockIsHeld("garbage", local, alive));
      // A foreign owner (a shared profile locked from another machine) names
      // a pid we cannot probe, so it is held regardless of local liveness.
      assert.isTrue(yield* firefoxSymlinkLockIsHeld("10.0.0.7:+9999", local, alive));
    }),
  );

  it.effect("does not treat a stale parent.lock file as a running browser", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-firefox-" });
        const context = yield* sourcePathContext.pipe(
          // Firefox's win32 root hangs off %APPDATA%; without it the root is
          // undefined and the fixture would escape the sandbox into the repo.
          Effect.provideService(HostProcessEnvironment, {
            HOME: home,
            APPDATA: `${home}/AppData/Roaming`,
          }),
          Effect.provideService(HostProcessPlatform, "win32"),
        );
        const root = firefox.userDataDirectory(context)!;
        const profile = `${root}/Profiles/gx7x7fqx.default-release`;
        yield* fileSystem.makeDirectory(profile, { recursive: true });
        yield* fileSystem.writeFileString(`${profile}/cookies.sqlite`, "db");

        // On Windows, Firefox creates parent.lock as a regular file that
        // persists after the process exits. The file is only locked while
        // Firefox is running; the old stat-based check always found it.
        yield* fileSystem.writeFileString(`${profile}/parent.lock`, "");
        assert.isFalse(yield* isSourceRunning(firefox, context));
      }),
    ),
  );
});

describe("Windows user-data directories", () => {
  it.effect("keeps app-bound Chromium forks unsupported on win32", () =>
    Effect.sync(() => {
      // Helium retains the older DPAPI-backed store. Other Chromium forks use
      // App-Bound Encryption, so omitting win32 makes `unavailableReason`
      // report `unsupportedPlatform` and keeps them out of the menu.
      for (const source of BROWSER_IMPORT_SOURCES) {
        if (source.engine === "chromium" && source.id !== "helium") {
          assert.notInclude(source.platforms, "win32");
        }
      }
    }),
  );
});

describe("listSourceProfiles hardening", () => {
  it.effect("drops profile directories that are not a single plain segment", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        // `Local State` is writable by anything running as the user, so a
        // crafted key must not reach `cookieDatabasePath` and read a database
        // outside the browser's user-data directory.
        yield* fileSystem.writeFileString(
          `${userDataDirectory(context)}/Local State`,
          `{"profile":{"info_cache":{"Default":{"name":"You"},"../../../../secrets":{"name":"Escape"},"a/b":{"name":"Nested"},"..":{"name":"Parent"}}}}`,
        );

        const profiles = yield* listSourceProfiles(helium, context);

        assert.deepEqual(
          profiles.map((profile) => profile.directory),
          ["Default"],
        );
      }),
    ),
  );
});

describe("Safari profiles", () => {
  const safari = BROWSER_IMPORT_SOURCES.find((source) => source.id === "safari")!;
  const workUuid = "C561D071-67AD-4537-866F-54F65FB8E8DD";
  const otherUuid = "2875EB19-B938-4E38-BE92-5AE97C256BDD";

  const fixture = Effect.fnUntraced(function* () {
    const context = yield* withSourceHome();
    const fileSystem = yield* FileSystem.FileSystem;
    const root = safari.userDataDirectory(context)!;
    const library = context.path.dirname(root);
    yield* fileSystem.makeDirectory(root, { recursive: true });
    yield* fileSystem.writeFileString(context.path.join(root, "Cookies.binarycookies"), "default");
    const store = (uuid: string) =>
      context.path.join(library, "WebKit", "WebsiteDataStore", uuid.toLowerCase(), "Cookies");
    for (const uuid of [workUuid, otherUuid]) {
      yield* fileSystem.makeDirectory(store(uuid), { recursive: true });
      yield* fileSystem.writeFileString(
        context.path.join(store(uuid), "Cookies.binarycookies"),
        uuid,
      );
    }
    yield* fileSystem.makeDirectory(context.path.join(library, "Safari"), { recursive: true });
    const metadata = context.path.join(library, "Safari", "SafariTabs.db");
    return { context, root, store, metadata };
  });

  it.effect("discovers named profiles and resolves only the selected profile's cookies", () =>
    run(
      Effect.gen(function* () {
        const { context, root, store, metadata } = yield* fixture();
        yield* Effect.sync(() => {
          const database = new NodeSqlite.DatabaseSync(metadata);
          try {
            database.exec(`CREATE TABLE bookmarks (
            title TEXT, external_uuid TEXT, parent INTEGER DEFAULT 0,
            type INTEGER DEFAULT 1, subtype INTEGER DEFAULT 2,
            deleted INTEGER DEFAULT 0, order_index INTEGER DEFAULT 0
          )`);
            const insert = database.prepare(
              "INSERT INTO bookmarks (title, external_uuid, deleted) VALUES (?, ?, ?)",
            );
            insert.run("", "DefaultProfile", 0);
            insert.run("Ping", workUuid, 0);
            insert.run("Deleted", otherUuid, 1);
            insert.run("Unsafe", "../../outside", 0);
            database.exec(
              "INSERT INTO bookmarks (title, external_uuid, subtype) VALUES ('Tab group', 'group', 1)",
            );
          } finally {
            database.close();
          }
        });
        const profiles = yield* listSourceProfiles(safari, context);
        assert.deepEqual(profiles, [
          { directory: ".", name: "Personal" },
          { directory: store(workUuid), name: "Ping" },
        ]);
        assert.strictEqual(
          yield* resolveCookieDatabase(safari, context, "."),
          context.path.join(root, "Cookies.binarycookies"),
        );
        const selected = yield* resolveCookieDatabase(safari, context, profiles[1]!.directory);
        assert.strictEqual(selected, context.path.join(store(workUuid), "Cookies.binarycookies"));
        const fileSystem = yield* FileSystem.FileSystem;
        assert.strictEqual(yield* fileSystem.readFileString(selected!), workUuid);
        yield* fileSystem.remove(selected!);
        assert.isUndefined(yield* resolveCookieDatabase(safari, context, profiles[1]!.directory));
        assert.deepEqual(yield* listSourceProfiles(safari, context), profiles);
      }),
    ),
  );

  for (const metadataState of ["missing", "corrupt"] as const) {
    it.effect(`recovers separate cookie stores when metadata is ${metadataState}`, () =>
      run(
        Effect.gen(function* () {
          const { context, store, metadata } = yield* fixture();
          const fileSystem = yield* FileSystem.FileSystem;
          if (metadataState === "corrupt") yield* fileSystem.writeFileString(metadata, "invalid");
          yield* fileSystem.remove(context.path.join(store(otherUuid), "Cookies.binarycookies"));
          assert.deepEqual(yield* listSourceProfiles(safari, context), [
            { directory: ".", name: "Safari" },
            { directory: store(workUuid), name: workUuid.toLowerCase() },
          ]);
          assert.isTrue(yield* isSourceInstalled(safari, context));
        }),
      ),
    );
  }

  it.effect("keeps Safari without profiles available", () =>
    run(
      Effect.gen(function* () {
        const context = yield* withSourceHome();
        assert.deepEqual(yield* listSourceProfiles(safari, context), [
          { directory: ".", name: "Safari" },
        ]);
        assert.isFalse(yield* isSourceInstalled(safari, context));
      }),
    ),
  );
});
