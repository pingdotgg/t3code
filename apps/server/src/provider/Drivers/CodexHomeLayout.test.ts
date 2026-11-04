// @effect-diagnostics nodeBuiltinImport:off - Real SQLite connections verify WAL recovery and concurrent access.
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CodexSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CodexShadowHomeEntryConflictError,
  CodexShadowHomePathConflictError,
  codexHomeEnvironment,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
const decodeCodexSettingsValue = Schema.decodeSync(CodexSettings);

const decodeCodexSettings = (input: {
  readonly enabled?: boolean;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly customModels?: readonly string[];
  readonly binaryPath?: string;
}): CodexSettings => decodeCodexSettingsValue(input);

const makeTempDir = Effect.fn("CodexHomeLayout.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTextFile = Effect.fn("CodexHomeLayout.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

it.layer(NodeServices.layer)("CodexHomeLayout", (it) => {
  describe("resolveCodexHomeLayout", () => {
    it.effect("uses the shared home for continuation and the shadow home for runtime", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        expect(layout).toMatchObject({
          mode: "authOverlay",
          sharedHomePath: sharedHome,
          effectiveHomePath: shadowHome,
          continuationKey: `codex:home:${sharedHome}`,
        });
      }),
    );
  });

  describe("codexHomeEnvironment", () => {
    it.effect.each(["live", "interrupted"] as const)(
      "reads committed private shadow WAL data with a %s connection",
      (connection) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const sharedDatabasePath = path.join(sharedHome, "state_5.sqlite");
          const shadowDatabasePath = path.join(shadowHome, "state_5.sqlite");
          {
            using seed = new NodeSqlite.DatabaseSync(sharedDatabasePath);
            seed.exec("PRAGMA journal_mode = WAL; CREATE TABLE entries (value TEXT);");
          }
          yield* fileSystem.copyFile(sharedDatabasePath, shadowDatabasePath);
          using writer = new NodeSqlite.DatabaseSync(shadowDatabasePath);
          writer.exec("PRAGMA wal_autocheckpoint = 0; INSERT INTO entries VALUES ('committed');");
          const database = yield* fileSystem.readFile(shadowDatabasePath);
          const walPath = `${shadowDatabasePath}-wal`;
          const wal = yield* fileSystem.readFile(walPath);
          expect(wal.byteLength).toBeGreaterThan(0);
          if (connection === "interrupted") {
            // Restore the uncheckpointed disk image only after SQLite closes our fixture.
            writer.close();
            yield* fileSystem.writeFile(shadowDatabasePath, database);
            yield* fileSystem.writeFile(walPath, wal);
          }
          {
            using sharedReader = new NodeSqlite.DatabaseSync(sharedDatabasePath);
            expect(sharedReader.prepare("SELECT value FROM entries").all()).toEqual([]);
          }

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          const environment = yield* codexHomeEnvironment(layout, {});
          expect(yield* fileSystem.readFile(walPath)).toEqual(wal);
          using reader = new NodeSqlite.DatabaseSync(
            path.join(environment.CODEX_SQLITE_HOME!, "state_5.sqlite"),
          );
          expect(reader.prepare("SELECT value FROM entries").all()).toEqual([
            { value: "committed" },
          ]);
          if (connection === "live") {
            writer.exec("INSERT INTO entries VALUES ('still writable');");
            expect(reader.prepare("SELECT count(*) AS count FROM entries").get()).toEqual({
              count: 2,
            });
          }
        }),
    );

    for (const platform of ["win32", "linux", "darwin"] as const) {
      it.effect.skipIf(!symlinksSupported)(
        `preserves SQLite home compatibility on ${platform}`,
        () =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const sharedHome = yield* makeTempDir("t3code-codex-shared-");
            const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
            const layout = yield* resolveCodexHomeLayout(
              decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
            );
            expect((yield* codexHomeEnvironment(layout, {})).CODEX_SQLITE_HOME).toBe(sharedHome);
            for (const name of ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm"]) {
              yield* writeTextFile(path.join(sharedHome, name), `shared ${name}`);
              const target =
                name === "state_5.sqlite"
                  ? path.relative(shadowHome, path.join(sharedHome, name))
                  : path.join(sharedHome, name);
              yield* fileSystem.symlink(target, path.join(shadowHome, name));
            }
            yield* materializeCodexShadowHome(layout);
            const legacyHome = platform === "win32" ? sharedHome : shadowHome;
            expect((yield* codexHomeEnvironment(layout, {})).CODEX_SQLITE_HOME).toBe(legacyHome);
            expect(
              (yield* codexHomeEnvironment(layout, { CODEX_SQLITE_HOME: "  " })).CODEX_SQLITE_HOME,
            ).toBe(legacyHome);

            yield* writeTextFile(path.join(shadowHome, "goals_1.sqlite"), "private goals");
            if (platform === "win32") {
              const error = yield* codexHomeEnvironment(layout, {}).pipe(Effect.flip);
              expect(error).toMatchObject({
                _tag: "CodexShadowHomeSqliteConflictError",
                sharedHomePath: sharedHome,
                effectiveHomePath: shadowHome,
              });
            } else {
              expect((yield* codexHomeEnvironment(layout, {})).CODEX_SQLITE_HOME).toBe(shadowHome);
            }
            for (const override of [sharedHome, shadowHome, "relative-sqlite-home"]) {
              expect(
                (yield* codexHomeEnvironment(layout, { CODEX_SQLITE_HOME: ` ${override} ` }))
                  .CODEX_SQLITE_HOME,
              ).toBe(override);
            }
            expect(yield* fileSystem.readFileString(path.join(shadowHome, "goals_1.sqlite"))).toBe(
              "private goals",
            );
            expect(yield* fileSystem.readLink(path.join(shadowHome, "state_5.sqlite"))).toBe(
              path.relative(shadowHome, path.join(sharedHome, "state_5.sqlite")),
            );
            yield* fileSystem.remove(path.join(shadowHome, "goals_1.sqlite"));
            yield* fileSystem.remove(path.join(shadowHome, "state_5.sqlite"));
            yield* fileSystem.symlink(
              path.join(sharedHome, "unrelated.sqlite"),
              path.join(shadowHome, "state_5.sqlite"),
            );
            if (platform === "win32") {
              expect(yield* codexHomeEnvironment(layout, {}).pipe(Effect.flip)).toMatchObject({
                _tag: "CodexShadowHomeSqliteConflictError",
                entryName: "state_5.sqlite",
              });
            } else {
              expect((yield* codexHomeEnvironment(layout, {})).CODEX_SQLITE_HOME).toBe(shadowHome);
            }
          }).pipe(Effect.provideService(HostProcess.Platform, platform)),
      );
    }

    it.effect.skipIf(!symlinksSupported || HostProcess.Platform.defaultValue() !== "win32")(
      "refuses an existing linked database with split committed WAL views without changing files",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const sharedDatabasePath = path.join(sharedHome, "state_5.sqlite");
          const shadowDatabasePath = path.join(shadowHome, "state_5.sqlite");
          {
            using seed = new NodeSqlite.DatabaseSync(sharedDatabasePath);
            seed.exec("PRAGMA journal_mode = WAL; CREATE TABLE entries (value TEXT);");
          }
          yield* fileSystem.symlink(sharedDatabasePath, shadowDatabasePath);
          const shadowWriter = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(shadowDatabasePath)),
            (database) => Effect.sync(() => database.close()),
          );
          shadowWriter.exec(
            "PRAGMA wal_autocheckpoint = 0; INSERT INTO entries VALUES ('shadow-committed');",
          );
          const sharedWriter = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(sharedDatabasePath)),
            (database) => Effect.sync(() => database.close()),
          );
          sharedWriter.exec(
            "PRAGMA wal_autocheckpoint = 0; INSERT INTO entries VALUES ('shared-committed');",
          );
          expect(shadowWriter.prepare("SELECT value FROM entries").all()).toEqual([
            { value: "shadow-committed" },
          ]);
          expect(sharedWriter.prepare("SELECT value FROM entries").all()).toEqual([
            { value: "shared-committed" },
          ]);
          const files = [
            sharedDatabasePath,
            `${sharedDatabasePath}-wal`,
            `${sharedDatabasePath}-shm`,
            `${shadowDatabasePath}-wal`,
            `${shadowDatabasePath}-shm`,
          ];
          const before = yield* Effect.forEach(files, (file) => fileSystem.readFile(file));
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          yield* materializeCodexShadowHome(layout);
          const error = yield* codexHomeEnvironment(layout, {}).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "CodexShadowHomeSqliteConflictError",
            sharedHomePath: sharedHome,
            effectiveHomePath: shadowHome,
          });
          expect(error.message).toContain("Stop all Codex processes");
          expect(yield* Effect.forEach(files, (file) => fileSystem.readFile(file))).toEqual(before);
          expect(yield* fileSystem.readLink(shadowDatabasePath)).toBe(sharedDatabasePath);
        }),
    );
  });

  describe("materializeCodexShadowHome", () => {
    it.effect.skipIf(!symlinksSupported)(
      "preserves SQLite files when shared sidecars appear after the shadow home starts",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          yield* writeTextFile(path.join(sharedHome, "logs_2.sqlite"), "shared logs");
          yield* writeTextFile(path.join(sharedHome, "state_5.sqlite"), "shared state");
          // An existing overlay may already link the database. Never remove its
          // live WAL or replace files while another Codex process has them open.
          yield* fileSystem.symlink(
            path.join(sharedHome, "state_5.sqlite"),
            path.join(shadowHome, "state_5.sqlite"),
          );
          yield* materializeCodexShadowHome(layout);

          const localFiles = ["logs_2.sqlite-shm", "logs_2.sqlite-wal", "state_5.sqlite-journal"];
          for (const name of localFiles) {
            yield* writeTextFile(path.join(shadowHome, name), `local ${name}`);
            yield* writeTextFile(path.join(sharedHome, name), `shared ${name}`);
          }
          yield* materializeCodexShadowHome(layout);
          yield* writeTextFile(path.join(shadowHome, "goals_1.sqlite"), "local goals");
          yield* writeTextFile(path.join(sharedHome, "goals_1.sqlite"), "shared goals");
          yield* materializeCodexShadowHome(layout);

          for (const name of localFiles) {
            expect(yield* fileSystem.readFileString(path.join(shadowHome, name))).toBe(
              `local ${name}`,
            );
            expect(yield* fileSystem.readFileString(path.join(sharedHome, name))).toBe(
              `shared ${name}`,
            );
          }
          expect(yield* fileSystem.exists(path.join(shadowHome, "logs_2.sqlite"))).toBe(false);
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "goals_1.sqlite"))).toBe(
            "local goals",
          );
          expect(yield* fileSystem.readLink(path.join(shadowHome, "state_5.sqlite"))).toBe(
            path.join(sharedHome, "state_5.sqlite"),
          );
          expect(yield* fileSystem.readLink(path.join(shadowHome, "sessions"))).toBe(
            path.join(sharedHome, "sessions"),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "keeps Finder metadata local across repeated shadow home setup",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const sharedMetadata = path.join(sharedHome, ".DS_Store");
          const shadowMetadata = path.join(shadowHome, ".DS_Store");

          yield* writeTextFile(sharedMetadata, "shared Finder metadata");
          yield* writeTextFile(shadowMetadata, "shadow Finder metadata");
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.readFileString(shadowMetadata)).toBe("shadow Finder metadata");
          yield* fileSystem.remove(shadowMetadata);
          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.exists(shadowMetadata)).toBe(false);

          yield* writeTextFile(shadowMetadata, "shadow Finder metadata");
          yield* materializeCodexShadowHome(layout);
          yield* materializeCodexShadowHome(layout);

          expect(yield* fileSystem.readFileString(sharedMetadata)).toBe("shared Finder metadata");
          expect(yield* fileSystem.readFileString(shadowMetadata)).toBe("shadow Finder metadata");
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "auth.json"))).toBe(
            '{"shadow":true}\n',
          );
          expect(yield* fileSystem.readLink(path.join(shadowHome, "sessions"))).toBe(
            path.join(sharedHome, "sessions"),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "materializes a shadow home with shared state links and private auth",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          yield* fileSystem.makeDirectory(path.join(sharedHome, "sessions"));
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(
            path.join(sharedHome, "models_cache.json"),
            '{"models":["shared"]}\n',
          );
          yield* writeTextFile(path.join(sharedHome, "auth.json"), '{"shared":true}\n');
          yield* writeTextFile(path.join(sharedHome, "auth.lock"), "");
          yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          yield* writeTextFile(path.join(shadowHome, "auth.lock"), "");
          yield* fileSystem.symlink(
            path.join(sharedHome, "models_cache.json"),
            path.join(shadowHome, "models_cache.json"),
          );

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const sessionsTarget = yield* fileSystem.readLink(path.join(shadowHome, "sessions"));
          const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
          const mcpOauthLocksTarget = yield* fileSystem.readLink(
            path.join(shadowHome, "mcp-oauth-locks"),
          );
          const modelsCacheExists = yield* fileSystem.exists(
            path.join(shadowHome, "models_cache.json"),
          );
          const authLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "auth.json"))
            .pipe(Effect.result);
          const authContents = yield* fileSystem.readFileString(path.join(shadowHome, "auth.json"));
          const authLockLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "auth.lock"))
            .pipe(Effect.result);

          expect(sessionsTarget).toBe(path.join(sharedHome, "sessions"));
          expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
          expect(mcpOauthLocksTarget).toBe(path.join(sharedHome, "mcp-oauth-locks"));
          expect(modelsCacheExists).toBe(false);
          expect(authLinkResult._tag).toBe("Failure");
          expect(authContents).toContain("shadow");
          expect(authLockLinkResult._tag).toBe("Failure");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "replaces a Codex-created local sqlite maintenance lock with the shared lock",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const sharedLock = path.join(sharedHome, ".sqlite-maintenance.lock");
          const shadowLock = path.join(shadowHome, ".sqlite-maintenance.lock");

          yield* writeTextFile(sharedLock, "");
          yield* writeTextFile(shadowLock, "");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          expect(yield* fileSystem.readLink(shadowLock)).toBe(sharedLock);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "replaces Codex-created local MCP OAuth locks with the shared lock directory",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const sharedLocks = path.join(sharedHome, "mcp-oauth-locks");
          const shadowLocks = path.join(shadowHome, "mcp-oauth-locks");

          yield* writeTextFile(path.join(sharedLocks, "file-store.lock"), "");
          yield* writeTextFile(path.join(shadowLocks, "file-store.lock"), "");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const locksTarget = yield* fileSystem.readLink(shadowLocks);
          const sharedLockExists = yield* fileSystem.exists(
            path.join(sharedLocks, "file-store.lock"),
          );

          expect(locksTarget).toBe(sharedLocks);
          expect(sharedLockExists).toBe(true);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "shares local thread writer locks once no writer still holds one",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const shadowLocks = path.join(shadowHome, "thread-writer-locks");
          const threadLock = path.join(shadowLocks, "019a0000-0000-7000-8000-000000000000.lock");

          yield* writeTextFile(path.join(shadowLocks, ".coordination.lock"), "");
          yield* writeTextFile(path.join(shadowLocks, ".DS_Store"), "");
          yield* writeTextFile(threadLock, "");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.exists(threadLock)).toBe(true);

          yield* fileSystem.remove(threadLock);
          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.readLink(shadowLocks)).toBe(
            path.join(sharedHome, "thread-writer-locks"),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "accepts Codex-created shadow-local runtime directories",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          yield* fileSystem.makeDirectory(path.join(sharedHome, "log"));
          yield* fileSystem.makeDirectory(path.join(sharedHome, "memories"));
          yield* fileSystem.makeDirectory(path.join(sharedHome, "tmp"));
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          yield* fileSystem.makeDirectory(path.join(shadowHome, "log"), { recursive: true });
          yield* fileSystem.makeDirectory(path.join(shadowHome, "memories"), { recursive: true });
          yield* fileSystem.makeDirectory(path.join(shadowHome, "tmp"), { recursive: true });

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
          const logLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "log"))
            .pipe(Effect.result);
          const memoriesLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "memories"))
            .pipe(Effect.result);
          const tmpLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "tmp"))
            .pipe(Effect.result);

          expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
          expect(logLinkResult._tag).toBe("Failure");
          expect(memoriesLinkResult._tag).toBe("Failure");
          expect(tmpLinkResult._tag).toBe("Failure");
        }),
    );

    it.effect("rejects shadow homes that point at the shared home", () =>
      Effect.gen(function* () {
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: sharedHome,
          }),
        );

        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

        expect(error).toBeInstanceOf(CodexShadowHomePathConflictError);
        expect(error).toMatchObject({
          sharedHomePath: sharedHome,
          effectiveHomePath: sharedHome,
        });
        expect(error.message).toBe(
          `Codex shadow home path '${sharedHome}' must be different from the shared home path '${sharedHome}'.`,
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects shared entries that already exist in the shadow home as real files",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(shadowHome, "config.toml"), 'model = "local"\n');

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CodexShadowHomeEntryConflictError);
          expect(error).toMatchObject({
            sharedHomePath: sharedHome,
            effectiveHomePath: shadowHome,
            entryName: "config.toml",
            linkPath: path.join(shadowHome, "config.toml"),
            targetPath: path.join(sharedHome, "config.toml"),
          });
          expect(error.message).toBe(
            `Cannot create Codex shadow home entry 'config.toml' because '${path.join(shadowHome, "config.toml")}' already exists and is not a symlink.`,
          );
        }),
    );
  });
});
