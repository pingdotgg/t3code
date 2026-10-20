import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import { vi } from "vite-plus/test";

import * as BrowserSession from "../BrowserSession.ts";
import * as BrowserImport from "./BrowserImport.ts";
import { BROWSER_IMPORT_SOURCES, sourcePathContext } from "./Sources.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const helium = BROWSER_IMPORT_SOURCES.find((source) => source.id === "helium")!;
const firefox = BROWSER_IMPORT_SOURCES.find((source) => source.id === "firefox")!;

// BrowserSession is supplied by the fixture; no Electron runtime is needed.
vi.mock("electron", () => ({}));

const cookie = {
  url: "https://rejected.example/path",
  name: "session",
  value: "value",
  domain: undefined,
  path: "/",
  secure: true,
  httpOnly: true,
  expirationDate: undefined,
  sameSite: "lax" as const,
};

const layerRejectedBeforeSession = Layer.succeed(
  BrowserSession.BrowserSession,
  BrowserSession.BrowserSession.of({
    getPartition: () => Effect.die("getPartition must not be reached"),
    isPartition: () => false,
    getSession: () => Effect.die("getSession must not be reached"),
    clearCookies: () => Effect.die("clearCookies must not be reached"),
    clearCache: () => Effect.die("clearCache must not be reached"),
  }),
);

const withImporter = Effect.fnUntraced(function* (
  platform: NodeJS.Platform = "darwin",
  source = helium,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-import-" });
  const environment = { HOME: home, LOCALAPPDATA: `${home}/AppData/Local` };
  const layerEnvironment = Layer.succeed(HostProcess.Environment, environment);
  const context = yield* sourcePathContext.pipe(
    Effect.provideService(HostProcess.Environment, environment),
    Effect.provideService(HostProcess.Platform, platform),
  );
  const root = source.userDataDirectory(context);
  if (root === undefined) throw new Error("Source has no user-data directory");
  yield* fileSystem.makeDirectory(`${root}/Default`, { recursive: true });
  // The cookie database is what marks a source as installed, so a fixture
  // without one is reported as absent before any other check runs.
  yield* fileSystem.writeFileString(
    `${root}/Default/${source.engine === "firefox" ? "cookies.sqlite" : "Cookies"}`,
    "db",
  );

  const importer = yield* BrowserImport.BrowserImport.pipe(
    Effect.provide(
      BrowserImport.layer.pipe(
        Layer.provide(layerRejectedBeforeSession),
        Layer.provide(layerEnvironment),
        Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
        Layer.provide(Layer.succeed(HostProcess.ExecutablePath, "/Applications/T3 Code.app")),
        Layer.provide(Layer.succeed(FileSystem.FileSystem, fileSystem)),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
  return { importer, home, root };
});

describe("BrowserImport", () => {
  it.effect("rejects a source profile the browser never reported", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { importer, home } = yield* withImporter();

      yield* fileSystem.makeDirectory(`${home}/secrets`, { recursive: true });
      yield* fileSystem.writeFileString(`${home}/secrets/Cookies`, "not-a-db");

      const error = yield* importer
        .importCookies({
          input: {
            sourceId: "helium",
            sourceProfileDirectory: "../../../../secrets",
            targetProfileId: "default",
          },
          scope: "persist:t3code-preview-test",
          persistent: true,
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, BrowserImport.BrowserImportFailedError);
      assert.equal(error.reason, "unknownSourceProfile");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  describe.skipIf(!symlinksSupported)("while the source browser is running", () => {
    it.effect.each(["darwin", "linux"] as const)("offers Chromium profiles on %s", (platform) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { importer, root } = yield* withImporter(platform);
        const hostname = yield* HostProcess.Hostname;
        yield* fileSystem.symlink(`${hostname}-${process.pid}`, `${root}/SingletonLock`);

        const sources = yield* importer.listSources;
        const source = sources.find((candidate) => candidate.id === "helium");

        assert.deepEqual(source, {
          id: "helium",
          name: "Helium",
          profiles: [{ directory: "Default", name: "Default" }],
        });
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  });

  it.effect.skipIf(!symlinksSupported)("still blocks imports from running Firefox", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { importer, root } = yield* withImporter("linux", firefox);
      yield* fileSystem.symlink(`127.0.0.1:+${process.pid}`, `${root}/Default/lock`);

      const source = (yield* importer.listSources).find((source) => source.id === "firefox");
      assert.equal(source?.unavailable, "browserRunning");
      assert.deepEqual(source?.profiles, []);
      const error = yield* importer
        .importCookies({
          input: {
            sourceId: "firefox",
            sourceProfileDirectory: "Default",
            targetProfileId: "default",
          },
          scope: "persist:t3code-preview-test",
          persistent: true,
        })
        .pipe(Effect.flip);
      assert.equal(error.reason, "browserRunning");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("still blocks Chromium imports when Windows holds the cookie database", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { importer } = yield* withImporter("win32").pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          // Windows reports a sharing violation when the running browser owns the jar.
          open: (path, options) =>
            options?.flag === "r+" && /[/\\]Cookies$/.test(path)
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "Busy",
                    module: "FileSystem",
                    method: "open",
                    pathOrDescriptor: path,
                  }),
                )
              : fileSystem.open(path, options),
        }),
      );
      const source = (yield* importer.listSources).find((source) => source.id === "helium");
      assert.equal(source?.unavailable, "browserRunning");
      assert.deepEqual(source?.profiles, []);
      const error = yield* importer
        .importCookies({
          input: {
            sourceId: "helium",
            sourceProfileDirectory: "Default",
            targetProfileId: "default",
          },
          scope: "persist:t3code-preview-test",
          persistent: true,
        })
        .pipe(Effect.flip);
      assert.equal(error.reason, "browserRunning");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("BrowserImport.writeCookies", () => {
  it.effect("counts a rejected cookie and its domain as skipped", () =>
    Effect.gen(function* () {
      let flushes = 0;
      const result = yield* BrowserImport.writeCookies(
        {
          cookies: {
            set: () => Promise.reject(new Error("fixture rejection")),
            flushStore: () => {
              flushes += 1;
              return Promise.resolve();
            },
          },
        },
        { cookies: [cookie], undecryptable: 0, undecryptableHosts: [] },
      );

      assert.deepEqual(result, {
        imported: 0,
        skipped: 1,
        skippedDomains: ["rejected.example"],
      });
      assert.equal(flushes, 0);
    }),
  );

  it.effect("flushes the store after writing, and reports success if the flush fails", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const result = yield* BrowserImport.writeCookies(
        {
          cookies: {
            set: () => {
              events.push("set");
              return Promise.resolve();
            },
            flushStore: () => {
              events.push("flush");
              return Promise.reject(new Error("fixture flush failure"));
            },
          },
        },
        { cookies: [cookie, cookie], undecryptable: 0, undecryptableHosts: [] },
      );

      assert.deepEqual(events, ["set", "set", "flush"]);
      assert.deepEqual(result, { imported: 2, skipped: 0, skippedDomains: [] });
    }),
  );

  it.effect("propagates interruption while writing a cookie", () =>
    Effect.gen(function* () {
      const write = BrowserImport.writeCookies(
        {
          cookies: {
            set: () => new Promise<void>(() => {}),
            flushStore: () => Promise.resolve(),
          },
        },
        { cookies: [cookie], undecryptable: 0, undecryptableHosts: [] },
      );

      const interrupted = yield* Ref.make(false);
      const fiber = yield* write.pipe(
        Effect.onInterrupt(() => Ref.set(interrupted, true)),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);

      assert.isTrue(yield* Ref.get(interrupted));
    }),
  );
});
