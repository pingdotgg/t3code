import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { BrowserImportSource } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { Session } from "electron";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Cipher from "effect/crypto/Cipher";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as Kdf from "effect/crypto/Kdf";
import { vi } from "vite-plus/test";

import * as BrowserSession from "../BrowserSession.ts";
import { readManagedPolicyFile } from "@t3tools/shared/managedPolicyFile";
import * as DesktopManagedPolicy from "../../app/DesktopManagedPolicy.ts";
import * as BrowserImport from "./BrowserImport.ts";
import { LinuxBrowserSecretPath } from "./LinuxBrowserSecret.ts";
import { BROWSER_IMPORT_SOURCES, sourcePathContext } from "./Sources.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const helium = BROWSER_IMPORT_SOURCES.find((source) => source.id === "helium")!;
const decodeImportSource = Schema.decodeEffect(BrowserImportSource);
const chromiumKeychainSecret = "fixture-chromium-keychain-secret";

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    readonly getPassword: () => Promise<string | undefined>;

    constructor(service: string, account: string) {
      this.getPassword = async () =>
        service === "Chromium Safe Storage" && account === "Chromium"
          ? chromiumKeychainSecret
          : undefined;
    }
  },
}));

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
    cookiesCleared: () => Effect.die("cookiesCleared must not be reached"),
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
        Layer.provide(NodeCrypto.layerDigest),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
  return { importer, home, root };
});

describe("BrowserImport.importCookies", () => {
  it.effect.each([
    { platform: "linux", cookiePath: "Cookies" },
    { platform: "linux", cookiePath: "Network/Cookies" },
    { platform: "darwin", cookiePath: "Network/Cookies" },
  ] as const)(
    "discovers and imports Chromium cookies on $platform from $cookiePath",
    ({ platform, cookiePath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-chromium-" });
        const root =
          platform === "darwin"
            ? `${home}/Library/Application Support/Chromium`
            : `${home}/.config/chromium`;
        yield* fileSystem.makeDirectory(`${root}/Default/Network`, { recursive: true });
        yield* fileSystem.writeFileString(
          `${root}/Local State`,
          JSON.stringify({ profile: { info_cache: { Default: { name: "Personal" } } } }),
        );
        const kdf = yield* Kdf.Kdf;
        const cipher = yield* Cipher.Cipher;
        const keyBytes = yield* kdf.derive(
          Kdf.pbkdf2({ hash: Digest.sha1, iterations: platform === "darwin" ? 1003 : 1 }),
          Buffer.from(platform === "darwin" ? chromiumKeychainSecret : "peanuts"),
          { salt: Buffer.from("saltysalt"), length: 16 },
        );
        const key = yield* Cipher.key(Cipher.aes128Cbc, keyBytes);
        const ciphertext = yield* cipher.encrypt(key, Buffer.from("fixture-session"), {
          iv: Buffer.alloc(16, 0x20),
        });
        const value = Buffer.concat([Buffer.from("v10"), ciphertext]);
        yield* Effect.sync(() => {
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
                  cookiesCleared: () => Effect.die("cookiesCleared must not be reached"),
                  clearCache: () => Effect.die("clearCache must not be reached"),
                }),
              ),
              Layer.provide(DesktopManagedPolicy.layerTest()),
              Layer.provide(Layer.succeed(HostProcess.Environment, { HOME: home })),
              Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
              Layer.provide(Layer.succeed(HostProcess.ExecutablePath, "/fixture/t3code")),
              Layer.provide(NodeCrypto.layerDigest),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        const source = (yield* importer.listSources()).find(
          (candidate) => candidate.id === "chromium",
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
        Effect.provide([NodeServices.layer, NodeCrypto.layerKdf, NodeCrypto.layerCipher]),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("scans and imports unlisted Chromium and Firefox browsers only on explicit scan", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-autodiscover-" });
      const appSupport = `${home}/Library/Application Support`;
      const librewolfProfileDirectory = path.join("Profiles", "main.default");

      const cometRoot = `${appSupport}/Comet`;
      yield* fileSystem.makeDirectory(`${cometRoot}/Default/Network`, { recursive: true });
      yield* fileSystem.writeFileString(
        `${cometRoot}/Local State`,
        '{"profile":{"info_cache":{"Default":{"name":"Work"}}}}',
      );
      const keyBytes = yield* (yield* Kdf.Kdf).derive(
        Kdf.pbkdf2({ hash: Digest.sha1, iterations: 1003 }),
        Buffer.from(chromiumKeychainSecret),
        { salt: Buffer.from("saltysalt"), length: 16 },
      );
      const ciphertext = yield* (yield* Cipher.Cipher).encrypt(
        yield* Cipher.key(Cipher.aes128Cbc, keyBytes),
        Buffer.from("comet-session"),
        { iv: Buffer.alloc(16, 0x20) },
      );
      yield* Effect.sync(() => {
        using db = new NodeSqlite.DatabaseSync(`${cometRoot}/Default/Network/Cookies`);
        db.exec(
          "create table meta (key text primary key, value text not null); insert into meta values ('version', '23');" +
            "create table cookies (host_key text, name text, value text, encrypted_value blob, path text, expires_utc integer, is_secure integer, is_httponly integer, samesite integer, top_frame_site_key text not null default '');",
        );
        db.prepare("insert into cookies values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          "comet.example",
          "sid",
          "",
          Buffer.concat([Buffer.from("v10"), ciphertext]),
          "/",
          0,
          1,
          1,
          1,
          "",
        );
      });

      const librewolfRoot = `${appSupport}/LibreWolf`;
      yield* fileSystem.makeDirectory(`${librewolfRoot}/Profiles/main.default`, {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        `${librewolfRoot}/profiles.ini`,
        "[Profile0]\nName=Default\nIsRelative=1\nPath=Profiles/main.default\n",
      );
      yield* Effect.sync(() => {
        using db = new NodeSqlite.DatabaseSync(
          `${librewolfRoot}/Profiles/main.default/cookies.sqlite`,
        );
        db.exec(
          "pragma user_version = 15;" +
            "create table moz_cookies (host text, name text, value text, path text, expiry integer, isSecure integer, isHttpOnly integer, sameSite integer, originAttributes text not null default '');",
        );
        db.prepare("insert into moz_cookies values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          "librewolf.example",
          "token",
          "lw-value",
          "/",
          0,
          1,
          1,
          1,
          "",
        );
      });

      const written: Electron.CookiesSetDetails[] = [];
      const session = {
        cookies: {
          set: (c: Electron.CookiesSetDetails) => {
            written.push(c);
            return Promise.resolve();
          },
          flushStore: () => Promise.resolve(),
        },
      } as unknown as Session;
      const importer = yield* BrowserImport.BrowserImport.pipe(
        Effect.provide(
          BrowserImport.layer.pipe(
            Layer.provide(
              Layer.succeed(BrowserSession.BrowserSession, {
                getPartition: () => Effect.die("unused"),
                isPartition: () => false,
                getSession: () => Effect.succeed(session),
                clearCookies: () => Effect.die("unused"),
                cookiesCleared: () => Effect.die("unused"),
                clearCache: () => Effect.die("unused"),
              }),
            ),
            Layer.provide(DesktopManagedPolicy.layerTest()),
            Layer.provide(Layer.succeed(HostProcess.Environment, { HOME: home })),
            Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
            Layer.provide(Layer.succeed(HostProcess.ExecutablePath, "/fixture/t3code")),
            Layer.provide(NodeCrypto.layerDigest),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );

      // Default listing skips disk scanning; unscanned discovered IDs are rejected even for a real root on disk.
      const digest = yield* Digest.Digest;
      const canonicalLibrewolfRoot = yield* fileSystem.realPath(librewolfRoot);
      const librewolfHash = yield* digest.digest(
        Digest.sha256,
        new TextEncoder().encode(`firefox\0${canonicalLibrewolfRoot}`),
      );
      const librewolfRealId =
        `discovered:firefox:${Hex.encode(librewolfHash).slice(0, 16)}` as const;
      const beforeScan = yield* importer.listSources();
      assert.isUndefined(beforeScan.find((s) => s.name === "Comet" || s.name === "LibreWolf"));
      const unscannedError = yield* importer
        .importCookies({
          input: {
            sourceId: librewolfRealId,
            sourceProfileDirectory: librewolfProfileDirectory,
            targetProfileId: "default",
          },
          scope: "persist:t3code-preview-test",
          persistent: true,
        })
        .pipe(Effect.flip);
      assert.equal(unscannedError._tag, "BrowserImportFailedError");
      if (unscannedError._tag === "BrowserImportFailedError") {
        assert.equal(unscannedError.reason, "unknownSource");
      }

      const sources = yield* importer.listSources({ scan: true });
      const comet = sources.find((s) => s.name === "Comet")!;
      const librewolf = sources.find((s) => s.name === "LibreWolf")!;
      assert.match(comet.id, /^discovered:chromium:[0-9a-f]{16}$/);
      assert.equal(librewolf.id, librewolfRealId);

      // Modifying a discovered Firefox fork's profiles.ini to point outside its root must not expose external profiles.
      const outsideProfile = path.join(home, "outside-profile");
      yield* fileSystem.makeDirectory(outsideProfile, { recursive: true });
      yield* fileSystem.writeFileString(path.join(outsideProfile, "cookies.sqlite"), "not-ours");
      yield* fileSystem.writeFileString(
        `${librewolfRoot}/profiles.ini`,
        `[Profile0]\nName=Default\nIsRelative=1\nPath=Profiles/main.default\n[Profile1]\nName=Outside\nIsRelative=0\nPath=${outsideProfile}\n`,
      );
      const cachedAfterEdit = (yield* importer.listSources()).find((s) => s.id === librewolf.id)!;
      assert.deepEqual(
        cachedAfterEdit.profiles.map((p) => p.directory),
        [librewolfProfileDirectory],
      );
      const outsideError = yield* importer
        .importCookies({
          input: {
            sourceId: librewolf.id,
            sourceProfileDirectory: outsideProfile,
            targetProfileId: "default",
          },
          scope: "persist:t3code-preview-test",
          persistent: true,
        })
        .pipe(Effect.flip);
      assert.equal(outsideError._tag, "BrowserImportFailedError");
      if (outsideError._tag === "BrowserImportFailedError") {
        assert.equal(outsideError.reason, "unknownSourceProfile");
      }

      assert.deepEqual(yield* decodeImportSource(librewolf), {
        id: librewolf.id,
        name: "LibreWolf",
        profiles: [{ directory: librewolfProfileDirectory, name: "Default", cookieCount: 1 }],
      });

      for (const [sourceId, sourceProfileDirectory] of [
        [comet.id, "Default"],
        [librewolf.id, librewolfProfileDirectory],
      ] as const) {
        assert.deepEqual(
          yield* importer.importCookies({
            input: { sourceId, sourceProfileDirectory, targetProfileId: "default" },
            scope: "persist:t3code-preview-test",
            persistent: true,
          }),
          { imported: 1, skipped: 0, skippedDomains: [] },
        );
      }
      assert.deepEqual(
        written.map((entry) => [entry.url, entry.name, entry.value]),
        [
          ["https://comet.example/", "sid", "comet-session"],
          ["https://librewolf.example/", "token", "lw-value"],
        ],
      );

      // Replacing a cached discovered root with a symlink must not redirect subsequent reads.
      if (symlinksSupported) {
        const redirectedRoot = path.join(home, "redirected-librewolf");
        yield* fileSystem.makeDirectory(path.join(redirectedRoot, "Profiles", "main.default"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(redirectedRoot, "profiles.ini"),
          "[Profile0]\nName=Default\nIsRelative=1\nPath=Profiles/main.default\n",
        );
        yield* fileSystem.writeFileString(
          path.join(redirectedRoot, "Profiles", "main.default", "cookies.sqlite"),
          "redirected",
        );
        yield* fileSystem.remove(librewolfRoot, { recursive: true });
        yield* fileSystem.symlink(redirectedRoot, librewolfRoot);
        const afterSwap = (yield* importer.listSources()).find((s) => s.id === librewolf.id)!;
        assert.equal(afterSwap.unavailable, "notInstalled");
        assert.deepEqual(afterSwap.profiles, []);
      }
    }).pipe(
      Effect.provide([
        NodeServices.layer,
        NodeCrypto.layerDigest,
        NodeCrypto.layerKdf,
        NodeCrypto.layerCipher,
      ]),
      Effect.scoped,
    ),
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
