// @effect-diagnostics nodeBuiltinImport:off - Builds a Chromium-shaped cookie
// table with the same native bindings the source reads.
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
  posixLockIsHeld,
  listSourceProfiles,
  sourcePathContext,
} from "./Sources.ts";

const helium = BROWSER_IMPORT_SOURCES.find((source) => source.id === "helium")!;

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

describe("isSourceRunning", () => {
  it.effect("reads Chromium's dangling SingletonLock symlink as a running browser", () =>
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

  it.effect("uses the provided hostname to classify Chromium locks", () =>
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

  it.effect("follows cookie database symlinks when detecting profiles", () =>
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
});

describe("cookieDatabaseCandidatePaths", () => {
  it.effect("prefers Network/Cookies and falls back to the legacy Cookies", () =>
    run(
      Effect.gen(function* () {
        const context = yield* withSourceHome();
        const profile = `${context.home}/Library/Application Support/net.imput.helium/Profile 1`;
        assert.deepEqual(cookieDatabaseCandidatePaths(helium, context, "Profile 1"), [
          `${profile}/Network/Cookies`,
          `${profile}/Cookies`,
        ]);
      }),
    ),
  );

  it.effect("resolves the live Network/ jar over a leftover root Cookies", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
        const root = helium.userDataDirectory(context);
        // Chromium 96+ keeps sessions in Network/; a root Cookies left behind
        // by the move is stale and must not be the one imported.
        yield* fileSystem.makeDirectory(`${root}/Default/Network`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/Default/Network/Cookies`, "live");
        yield* fileSystem.writeFileString(`${root}/Default/Cookies`, "stale");

        assert.equal(
          yield* resolveCookieDatabase(helium, context, "Default"),
          `${root}/Default/Network/Cookies`,
        );
        // A fresh install with only the Network/ jar is installed, not hidden.
        yield* fileSystem.remove(`${root}/Default/Cookies`);
        assert.isTrue(yield* isSourceInstalled(helium, context));
      }),
    ),
  );
});

const firefox = BROWSER_IMPORT_SOURCES.find((source) => source.id === "firefox")!;

describe("listSourceProfiles Firefox fallback", () => {
  const cases = [
    { platform: "linux" as const, profileDirectory: "linux.default" },
    { platform: "darwin" as const, profileDirectory: "Profiles/macos.default" },
    { platform: "win32" as const, profileDirectory: "Profiles/windows.default" },
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
          { directory: "Profiles/declared.default", name: "Declared", cookieCount: 2 },
        ]);

        yield* fileSystem.remove(path.join(root, "profiles.ini"));
        const fallbackDirectory = path.join(root, "Profiles", "fallback.default");
        yield* fileSystem.makeDirectory(fallbackDirectory, { recursive: true });
        yield* writeFirefoxCookieDatabase(path.join(fallbackDirectory, "cookies.sqlite"), 1, 4);

        assert.deepEqual(yield* listSourceProfiles(firefox, context), [
          { directory: "Profiles/declared.default", name: "declared.default", cookieCount: 2 },
          { directory: "Profiles/fallback.default", name: "fallback.default", cookieCount: 1 },
        ]);
      }),
    ),
  );
});

describe("isSourceRunning for Firefox", () => {
  it.effect("finds the lock inside the profile, not at the root", () =>
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

  it.effect("detects a live fcntl lock on .parentlock, as macOS Firefox leaves it", () =>
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
