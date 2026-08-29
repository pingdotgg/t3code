import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as BrowserSession from "../BrowserSession.ts";
import * as BrowserImport from "./BrowserImport.ts";
import { BROWSER_IMPORT_SOURCES, sourcePaths } from "./Sources.ts";

const helium = BROWSER_IMPORT_SOURCES.find((source) => source.id === "helium")!;

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

/**
 * Dies if the import reaches session work: every case here covers a request
 * that must be rejected before a cookie is read or written.
 */
const rejectedBeforeSession = Layer.succeed(BrowserSession.BrowserSession, {
  derivePartition: () => Effect.die("derivePartition must not be reached"),
  getSession: () => Effect.die("getSession must not be reached"),
  clearStorage: () => Effect.die("clearStorage must not be reached"),
  clearCache: () => Effect.die("clearCache must not be reached"),
} as unknown as BrowserSession.BrowserSession["Service"]);

/**
 * Builds the service against a scratch home containing an installed, closed
 * copy of the source browser.
 */
const withImporter = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-import-" });
  const environment = Layer.succeed(HostProcessEnvironment, { HOME: home });
  const paths = yield* sourcePaths.pipe(
    Effect.provideService(HostProcessEnvironment, { HOME: home }),
  );
  yield* fileSystem.makeDirectory(`${helium.userDataDirectory(paths)}/Default`, {
    recursive: true,
  });
  // The cookie database is what marks a source as installed, so a fixture
  // without one is reported as absent before any other check runs.
  yield* fileSystem.writeFileString(`${helium.userDataDirectory(paths)}/Default/Cookies`, "db");

  const importer = yield* BrowserImport.BrowserImport.pipe(
    Effect.provide(
      BrowserImport.layer.pipe(
        Layer.provide(rejectedBeforeSession),
        Layer.provide(environment),
        Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
        Layer.provide(Layer.succeed(HostProcessExecutablePath, "/Applications/T3 Code.app")),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
  return { importer, home, paths };
});

describe("BrowserImport.importCookies", () => {
  it.effect("rejects a source profile the browser never reported", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { importer, home } = yield* withImporter();

      // A cookie database reachable on disk but outside the browser's
      // user-data directory — the payoff a traversal would be after.
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

  it.effect("refuses to import while the source browser holds its profile", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { importer, paths } = yield* withImporter();
      // The lock Chromium leaves while it is running, dangling target and
      // all. This must stop the import before it ever asks the keychain.
      yield* fileSystem.symlink(
        "host-that-does-not-exist-1234",
        `${helium.userDataDirectory(paths)}/SingletonLock`,
      );

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
      const result = yield* BrowserImport.writeCookies(
        {
          cookies: {
            set: () => Promise.reject(new Error("fixture rejection")),
          },
        },
        { cookies: [cookie], undecryptable: 0, undecryptableHosts: [] },
      );

      assert.deepEqual(result, {
        imported: 0,
        skipped: 1,
        skippedDomains: ["rejected.example"],
      });
    }),
  );

  it.effect("propagates interruption while writing a cookie", () =>
    Effect.gen(function* () {
      const write = BrowserImport.writeCookies(
        {
          cookies: {
            set: () => new Promise<void>(() => {}),
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
