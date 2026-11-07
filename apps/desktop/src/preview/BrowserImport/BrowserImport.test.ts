// @effect-diagnostics nodeBuiltinImport:off - Builds an encrypted Chromium cookie database fixture.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { BrowserImportSource } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { Session } from "electron";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as BrowserSession from "../BrowserSession.ts";
import { readManagedPolicyFile } from "@t3tools/shared/managedPolicyFile";
import * as DesktopManagedPolicy from "../../app/DesktopManagedPolicy.ts";
import * as BrowserImport from "./BrowserImport.ts";
import { LinuxBrowserSecretPath } from "./LinuxBrowserSecret.ts";
import { BROWSER_IMPORT_SOURCES, sourcePathContext } from "./Sources.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const helium = BROWSER_IMPORT_SOURCES.find((source) => source.id === "helium")!;
const decodeImportSource = Schema.decodeEffect(BrowserImportSource);

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

const withImporter = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-import-" });
  const layerEnvironment = Layer.succeed(HostProcess.Environment, { HOME: home });
  const context = yield* sourcePathContext.pipe(
    Effect.provideService(HostProcess.Environment, { HOME: home }),
    Effect.provideService(HostProcess.Platform, "darwin"),
  );
  const root = helium.userDataDirectory(context);
  if (root === undefined) throw new Error("Helium has no macOS user-data directory");
  yield* fileSystem.makeDirectory(`${root}/Default`, { recursive: true });
  yield* fileSystem.writeFileString(`${root}/Default/Cookies`, "db");

  const importer = yield* BrowserImport.BrowserImport.pipe(
    Effect.provide(
      BrowserImport.layer.pipe(
        Layer.provide(layerRejectedBeforeSession),
        Layer.provide(DesktopManagedPolicy.layerTest()),
        Layer.provide(layerEnvironment),
        Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
        Layer.provide(Layer.succeed(HostProcess.ExecutablePath, "/Applications/T3 Code.app")),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
  return { importer, home, root };
});

describe("BrowserImport.importCookies", () => {
  it.effect.each(["Cookies", "Network/Cookies"])(
    "discovers and imports Linux Chromium cookies from %s",
    (cookiePath) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-chromium-" });
        const root = `${home}/.config/chromium`;
        yield* fileSystem.makeDirectory(`${root}/Default/Network`, { recursive: true });
        yield* fileSystem.writeFileString(
          `${root}/Local State`,
          JSON.stringify({ profile: { info_cache: { Default: { name: "Personal" } } } }),
        );
        yield* Effect.sync(() => {
          const key = NodeCrypto.pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
          const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
          const value = Buffer.concat([
            Buffer.from("v10"),
            cipher.update("fixture-session"),
            cipher.final(),
          ]);
          using database = new NodeSqlite.DatabaseSync(`${root}/Default/${cookiePath}`);
          database.exec(`
            create table meta (key text primary key, value text not null);
            insert into meta values ('version', '23');
            create table cookies (
              host_key text, name text, value text, encrypted_value blob, path text,
              expires_utc integer, is_secure integer, is_httponly integer, samesite integer,
              top_frame_site_key text not null default ''
            );
          `);
          database
            .prepare("insert into cookies values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run("chromium.example", "session", "", value, "/", 0, 1, 1, 1, "");
        });

        const written: Electron.CookiesSetDetails[] = [];
        let flushed = false;
        const session = {
          cookies: {
            set: (cookie: Electron.CookiesSetDetails) => {
              written.push(cookie);
              return Promise.resolve();
            },
            flushStore: () => {
              flushed = true;
              return Promise.resolve();
            },
          },
        } as unknown as Session;
        const importer = yield* BrowserImport.BrowserImport.pipe(
          Effect.provide(
            BrowserImport.layer.pipe(
              Layer.provide(
                Layer.succeed(BrowserSession.BrowserSession, {
                  getPartition: () => Effect.die("getPartition must not be reached"),
                  isPartition: () => false,
                  getSession: () => Effect.succeed(session),
                  clearCookies: () => Effect.die("clearCookies must not be reached"),
                  clearCache: () => Effect.die("clearCache must not be reached"),
                }),
              ),
              Layer.provide(Layer.succeed(HostProcess.Environment, { HOME: home })),
              Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
              Layer.provide(Layer.succeed(HostProcess.ExecutablePath, "/fixture/t3code")),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        const source = (yield* importer.listSources).find(
          (candidate) => candidate.name === "Chromium",
        );
        assert.isDefined(source);
        assert.deepEqual(yield* decodeImportSource(source!), {
          id: "chromium",
          name: "Chromium",
          profiles: [{ directory: "Default", name: "Personal", cookieCount: 1 }],
        });
        assert.deepEqual(
          yield* importer.importCookies({
            input: {
              sourceId: "chromium",
              sourceProfileDirectory: "Default",
              targetProfileId: "default",
            },
            scope: "persist:t3code-preview-test",
            persistent: true,
          }),
          { imported: 1, skipped: 0, skippedDomains: [] },
        );
        assert.deepEqual(written, [
          {
            url: "https://chromium.example/",
            name: "session",
            value: "fixture-session",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "lax",
          },
        ]);
        assert.isTrue(flushed);
      }).pipe(
        Effect.provideService(LinuxBrowserSecretPath, undefined),
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
  );

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

  it.effect.skipIf(!symlinksSupported)(
    "refuses to import while the source browser holds its profile",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { importer, root } = yield* withImporter();
        yield* fileSystem.symlink("host-that-does-not-exist-1234", `${root}/SingletonLock`);

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

        assert.instanceOf(error, BrowserImport.BrowserImportFailedError);
        assert.equal(error.reason, "browserRunning");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("BrowserImport.checkBrowserImportPolicy", () => {
  it.effect("allows imports unless a readable policy turns them off, and fails closed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-import-policy-" });
      const outcome = (contents: string | undefined) =>
        Effect.gen(function* () {
          const policyPath = `${dir}/policy.json`;
          yield* fileSystem.remove(policyPath, { force: true });
          if (contents !== undefined) yield* fileSystem.writeFileString(policyPath, contents);
          const readPolicy = readManagedPolicyFile(policyPath).pipe(
            Effect.map((document) => document && { source: policyPath, document }),
          );
          return yield* BrowserImport.checkBrowserImportPolicy(readPolicy).pipe(
            Effect.match({ onFailure: (error) => error.message, onSuccess: () => "allowed" }),
          );
        });
      const policy = (limits?: object) =>
        JSON.stringify({ schemaVersion: 1, organization: "Example Corp", limits });

      assert.equal(yield* outcome(undefined), "allowed");
      assert.equal(yield* outcome(policy()), "allowed");
      assert.equal(yield* outcome(policy({ browserCookieImport: true })), "allowed");
      assert.equal(
        yield* outcome(policy({ browserCookieImport: false })),
        "Example Corp's policy does not allow importing browser cookies.",
      );
      for (const unreadable of ["{ not json", policy({ notALimit: false })]) {
        assert.include(yield* outcome(unreadable), "could not be read");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("BrowserImport.writeCookies", () => {
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
});
