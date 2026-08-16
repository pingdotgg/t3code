// @effect-diagnostics nodeBuiltinImport:off - Builds the on-disk browser layout the import reads.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessExecutablePath, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as BrowserSession from "../BrowserSession.ts";
import * as BrowserImport from "./BrowserImport.ts";
import { BROWSER_IMPORT_SOURCES } from "./Sources.ts";

const helium = BROWSER_IMPORT_SOURCES.find((source) => source.id === "helium")!;

/**
 * Fails loudly if the import ever reaches session work: every test here covers
 * a request that must be rejected before a cookie is read or written.
 */
const rejectedBeforeSession = Layer.succeed(BrowserSession.BrowserSession, {
  derivePartition: () => Effect.die("derivePartition must not be reached"),
  getSession: () => Effect.die("getSession must not be reached"),
  clearStorage: () => Effect.die("clearStorage must not be reached"),
  clearCache: () => Effect.die("clearCache must not be reached"),
} as unknown as BrowserSession.BrowserSession["Service"]);

const layer = BrowserImport.layer.pipe(
  Layer.provide(rejectedBeforeSession),
  Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
  Layer.provide(Layer.succeed(HostProcessExecutablePath, "/Applications/T3 Code.app")),
);

const withScratchHome = Effect.fnUntraced(function* () {
  const realHome = process.env.HOME;
  const home = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-import-"))),
    (dir) =>
      Effect.promise(async () => {
        if (realHome === undefined) delete process.env.HOME;
        else process.env.HOME = realHome;
        await NodeFSP.rm(dir, { recursive: true, force: true });
      }),
  );
  process.env.HOME = home;
  yield* Effect.promise(() =>
    NodeFSP.mkdir(NodePath.join(helium.userDataDirectory(), "Default"), { recursive: true }),
  );
  return home;
});

describe("BrowserImport.importCookies", () => {
  it.effect("rejects a profile directory the source never reported", () =>
    Effect.gen(function* () {
      const home = yield* withScratchHome();
      // A cookie database that is reachable on disk but outside the browser's
      // user-data directory — the payoff a traversal would be after.
      const secrets = NodePath.join(home, "secrets");
      yield* Effect.promise(() => NodeFSP.mkdir(secrets, { recursive: true }));
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(secrets, "Cookies"), "not-a-db"));

      const importer = yield* BrowserImport.BrowserImport;
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
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
