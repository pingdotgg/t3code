// @effect-diagnostics nodeBuiltinImport:off - Builds a Chromium-shaped cookie
// table with the same native bindings the source reads.
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import * as NodeSqlite from "node:sqlite";
import type { BrowserImportPathContext } from "./Sources.ts";
import {
  BROWSER_IMPORT_SOURCES,
  chromiumProcessIsAlive,
  chromiumSingletonLockIsHeld,
  firefoxSymlinkLockIsHeld,
  resolveCookieDatabase,
  isSourceInstalled,
  isSourceRunning,
  listSourceProfiles,
  sourcePathContext,
  windowsChromiumCookiesAreHeld,
} from "./Sources.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const helium = BROWSER_IMPORT_SOURCES.find((source) => source.id === "helium")!;

const withSourceHome = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-sources-" });
  const context = yield* sourcePathContext.pipe(
    Effect.provideService(HostProcess.Environment, { HOME: home }),
    Effect.provideService(HostProcess.Platform, "darwin"),
  );
  yield* fileSystem.makeDirectory(userDataDirectory(context), { recursive: true });
  return context;
});

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

const firefox = BROWSER_IMPORT_SOURCES.find((source) => source.id === "firefox")!;

const zen = BROWSER_IMPORT_SOURCES.find((source) => source.id === "zen")!;

describe("isSourceRunning for Firefox", () => {
  it.effect.skipIf(!symlinksSupported)("finds the lock inside the profile, not at the root", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-firefox-" });
        const context = yield* sourcePathContext.pipe(
          Effect.provideService(HostProcess.Environment, { HOME: home }),
          Effect.provideService(HostProcess.Platform, "darwin"),
        );
        const root = firefox.userDataDirectory(context)!;
        const profile = `${root}/Profiles/abcd.default-release`;
        yield* fileSystem.makeDirectory(profile, { recursive: true });
        yield* fileSystem.writeFileString(`${profile}/cookies.sqlite`, "db");

        assert.isFalse(yield* isSourceRunning(firefox, context));

        yield* fileSystem.writeFileString(`${root}/lock`, "");
        assert.isFalse(yield* isSourceRunning(firefox, context));

        yield* fileSystem.writeFileString(`${profile}/.parentlock`, "");
        assert.isFalse(yield* isSourceRunning(firefox, context));

        yield* fileSystem.symlink(`127.0.0.1:+${process.pid}`, `${profile}/lock`);
        assert.isTrue(yield* isSourceRunning(firefox, context));
      }),
    ),
  );

  it.effect("reads a Firefox lock symlink's pid to tell live from crashed", () =>
    Effect.gen(function* () {
      const alive = (pid: number) => Effect.succeed(pid === 4242);
      const local = new Set(["127.0.0.1", "127.0.1.1", "192.168.1.20"]);
      assert.isTrue(yield* firefoxSymlinkLockIsHeld("127.0.0.1:4242", local, alive));
      assert.isTrue(yield* firefoxSymlinkLockIsHeld("127.0.1.1:+4242", local, alive));
      assert.isTrue(yield* firefoxSymlinkLockIsHeld("192.168.1.20:+4242", local, alive));
      assert.isFalse(yield* firefoxSymlinkLockIsHeld("127.0.0.1:+9999", local, alive));
      assert.isFalse(yield* firefoxSymlinkLockIsHeld("192.168.1.20:+9999", local, alive));
      assert.isTrue(yield* firefoxSymlinkLockIsHeld("garbage", local, alive));
      assert.isTrue(yield* firefoxSymlinkLockIsHeld("10.0.0.7:+9999", local, alive));
    }),
  );

  it.effect("does not treat a stale parent.lock file as a running browser", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-firefox-" });
        const context = yield* sourcePathContext.pipe(
          // Without APPDATA, the Windows Firefox fixture would escape into the repo.
          Effect.provideService(HostProcess.Environment, {
            HOME: home,
            APPDATA: `${home}/AppData/Roaming`,
          }),
          Effect.provideService(HostProcess.Platform, "win32"),
        );
        const root = firefox.userDataDirectory(context)!;
        const profile = `${root}/Profiles/gx7x7fqx.default-release`;
        yield* fileSystem.makeDirectory(profile, { recursive: true });
        yield* fileSystem.writeFileString(`${profile}/cookies.sqlite`, "db");

        yield* fileSystem.writeFileString(`${profile}/parent.lock`, "");
        assert.isFalse(yield* isSourceRunning(firefox, context));
      }),
    ),
  );
});

describe("listSourceProfiles hardening", () => {
  it.effect("drops profile directories that are not a single plain segment", () =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const context = yield* withSourceHome();
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

  it.effect.each(["missing", "corrupt"] as const)(
    "recovers separate cookie stores when metadata is %s",
    (metadataState) =>
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
});
