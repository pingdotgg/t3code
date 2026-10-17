// @effect-diagnostics nodeBuiltinImport:off -- Exercises WAL behavior only in disposable test homes.
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { CodexSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  CodexShadowHomeEntryConflictError,
  CodexShadowHomePathConflictError,
  CodexShadowHomeSqliteRecoveryRequiredError,
  inspectCodexShadowSqlite,
  materializeCodexShadowHome,
  mergeCodexEnvironment,
  resolveCodexHomeLayout,
  withCodexSqliteHome,
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
    it.effect("uses direct CODEX_HOME when no shadow home is configured", () =>
      Effect.gen(function* () {
        const homePath = yield* makeTempDir("t3code-codex-home-");

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath,
          }),
        );

        expect(layout).toMatchObject({
          mode: "direct",
          sharedHomePath: homePath,
          effectiveHomePath: homePath,
          continuationKey: `codex:home:${homePath}`,
        });
      }),
    );

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

  describe("withCodexSqliteHome", () => {
    it.effect(
      "defaults overlays to shared SQLite without changing explicit or direct-home settings",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const direct = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome }),
          );
          const overlay = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: path.join(sharedHome, "shadow"),
            }),
          );
          const environment = { PATH: "/bin" };
          expect(withCodexSqliteHome(overlay, environment, "linux")).toEqual({
            PATH: "/bin",
            CODEX_SQLITE_HOME: sharedHome,
          });
          expect(
            withCodexSqliteHome(overlay, { CODEX_SQLITE_HOME: "/explicit/sqlite" }, "linux"),
          ).toEqual({
            CODEX_SQLITE_HOME: "/explicit/sqlite",
          });
          expect(withCodexSqliteHome(direct, environment, "linux")).toBe(environment);
          expect(environment).toEqual({ PATH: "/bin" });
        }),
    );
  });

  it.effect.each(["linux", "win32"] as const)(
    "matches explicit SQLite environment names using $0 semantics",
    (platform) =>
      Effect.gen(function* () {
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );
        const environment = { codex_sqlite_home: "/explicit/sqlite" };
        const resolved = withCodexSqliteHome(layout, environment, platform);
        expect(resolved.CODEX_SQLITE_HOME).toBe(
          platform === "win32" ? "/explicit/sqlite" : sharedHome,
        );
        expect(environment).toEqual({ codex_sqlite_home: "/explicit/sqlite" });
      }),
  );

  it.effect.each([
    { inherited: "CODEX_SQLITE_HOME", provider: "codex_sqlite_home" },
    { inherited: "codex_sqlite_home", provider: "CODEX_SQLITE_HOME" },
  ])(
    "merges Windows SQLite sources before defaulting ($inherited, $provider)",
    ({ inherited, provider }) =>
      Effect.gen(function* () {
        const environment = yield* mergeCodexEnvironment(
          [{ name: provider, value: "/provider/sqlite", sensitive: false }],
          { [inherited]: "/inherited/sqlite" },
        );
        expect(environment.CODEX_SQLITE_HOME).toBe("/provider/sqlite");
        expect(Object.keys(environment)).toEqual(["CODEX_SQLITE_HOME"]);
      }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );

  it.effect("preflights a fresh terminal shadow without creating it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeTempDir("t3code-codex-preflight-");
      const layout = yield* resolveCodexHomeLayout(
        decodeCodexSettings({
          homePath: path.join(root, "shared"),
          shadowHomePath: path.join(root, "shadow"),
        }),
      );
      expect(yield* inspectCodexShadowSqlite(layout)).toBeUndefined();
      expect(yield* fs.readDirectory(root)).toEqual([]);
    }),
  );

  describe("materializeCodexShadowHome", () => {
    for (const { databaseName, sidecarName } of [
      { databaseName: "STATE_5.sqlite", sidecarName: "state_5.sqlite-wal" },
      { databaseName: "state_5.SQLITE", sidecarName: "state_5.sqlite-SHM" },
      { databaseName: "state_5.SQLITE", sidecarName: undefined },
    ]) {
      it.effect.skipIf(!symlinksSupported)(
        `blocks SQLite links regardless of filename casing: ${databaseName} / ${sidecarName ?? "database link"}`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const sharedHome = yield* makeTempDir("t3code-codex-case-shared-");
            const shadowHome = yield* makeTempDir("t3code-codex-case-shadow-");
            const databasePath = path.join(shadowHome, databaseName);
            const linkPath = path.join(shadowHome, sidecarName ?? databaseName);
            const target = path.join(sharedHome, sidecarName ?? "state_5.sqlite");
            yield* fs.writeFileString(target, "shared bytes");
            if (sidecarName) yield* fs.writeFileString(databasePath, "shadow database");
            yield* fs.symlink(target, linkPath);
            const layout = yield* resolveCodexHomeLayout(
              decodeCodexSettings({
                homePath: sharedHome,
                shadowHomePath: shadowHome,
              }),
            );
            const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);
            expect(error).toBeInstanceOf(CodexShadowHomeSqliteRecoveryRequiredError);
            expect(yield* fs.readLink(linkPath)).toBe(target);
            expect(yield* fs.readFileString(target)).toBe("shared bytes");
            if (sidecarName) expect(yield* fs.readFileString(databasePath)).toBe("shadow database");
          }),
      );
    }

    it.effect.each([false, true])(
      "does not link SQLite families and preserves real files (shadow databases: %s)",
      (hasShadowFiles) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const names = ["state_5.sqlite", "logs_2.sqlite", "future_42.sqlite"].flatMap((name) => [
            name,
            `${name}-wal`,
            `${name}-shm`,
            `${name}-journal`,
          ]);
          for (const name of names) {
            yield* writeTextFile(path.join(sharedHome, name), `shared:${name}`);
            if (hasShadowFiles) yield* writeTextFile(path.join(shadowHome, name), `shadow:${name}`);
          }
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );
          yield* materializeCodexShadowHome(layout);
          yield* materializeCodexShadowHome(layout);
          for (const name of names) {
            expect(yield* fs.readFileString(path.join(sharedHome, name))).toBe(`shared:${name}`);
            expect(yield* fs.exists(path.join(shadowHome, name))).toBe(hasShadowFiles);
            if (hasShadowFiles) {
              expect(yield* fs.readFileString(path.join(shadowHome, name))).toBe(`shadow:${name}`);
              expect((yield* fs.stat(path.join(shadowHome, name))).type).toBe("File");
            }
          }
        }),
      { skip: !symlinksSupported },
    );

    it.effect.skipIf(!symlinksSupported)(
      "blocks a legacy database link without touching its regular WAL or SHM files",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          yield* writeTextFile(path.join(sharedHome, "state_5.sqlite"), "shared database");
          yield* fs.symlink(
            path.join(sharedHome, "state_5.sqlite"),
            path.join(shadowHome, "state_5.sqlite"),
          );
          for (const suffix of ["wal", "shm"]) {
            yield* writeTextFile(
              path.join(sharedHome, `state_5.sqlite-${suffix}`),
              `shared:${suffix}`,
            );
            yield* writeTextFile(
              path.join(shadowHome, `state_5.sqlite-${suffix}`),
              `uncheckpointed:${suffix}`,
            );
          }
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );
          for (const attempt of [1, 2]) {
            const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);
            expect(error, `attempt ${attempt}`).toBeInstanceOf(
              CodexShadowHomeSqliteRecoveryRequiredError,
            );
            expect(error.message).toContain("Stop all Codex processes");
          }
          expect(yield* fs.readLink(path.join(shadowHome, "state_5.sqlite"))).toBe(
            path.join(sharedHome, "state_5.sqlite"),
          );
          expect(yield* fs.readFileString(path.join(sharedHome, "state_5.sqlite"))).toBe(
            "shared database",
          );
          for (const suffix of ["wal", "shm"]) {
            expect(
              yield* fs.readFileString(path.join(sharedHome, `state_5.sqlite-${suffix}`)),
            ).toBe(`shared:${suffix}`);
            expect(
              yield* fs.readFileString(path.join(shadowHome, `state_5.sqlite-${suffix}`)),
            ).toBe(`uncheckpointed:${suffix}`);
          }
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "blocks a linked sidecar beside a real shadow database without changing either",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const database = path.join(shadowHome, "state_5.sqlite");
          const sidecar = path.join(shadowHome, "state_5.sqlite-wal");
          const target = path.join(sharedHome, "state_5.sqlite-wal");
          yield* fs.writeFileString(database, "private database");
          yield* fs.writeFileString(target, "shared WAL");
          yield* fs.symlink(target, sidecar);
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          expect(yield* materializeCodexShadowHome(layout).pipe(Effect.flip)).toBeInstanceOf(
            CodexShadowHomeSqliteRecoveryRequiredError,
          );
          expect(yield* fs.readFileString(database)).toBe("private database");
          expect(yield* fs.readLink(sidecar)).toBe(target);
          expect(yield* fs.readFileString(target)).toBe("shared WAL");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "requires manual recovery for dangling sidecar links and preserves real sidecars",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const dangling = "logs_1.sqlite-shm";
          yield* fs.symlink(path.join(sharedHome, dangling), path.join(shadowHome, dangling));
          yield* writeTextFile(path.join(shadowHome, "state_5.sqlite-wal"), "preserved WAL");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );
          for (const attempt of [1, 2]) {
            expect(
              yield* materializeCodexShadowHome(layout).pipe(Effect.flip),
              `attempt ${attempt}`,
            ).toBeInstanceOf(CodexShadowHomeSqliteRecoveryRequiredError);
            expect(yield* fs.readLink(path.join(shadowHome, dangling))).toBe(
              path.join(sharedHome, dangling),
            );
          }
          // Only an operator's explicit unlink clears the legacy entry.
          yield* fs.remove(path.join(shadowHome, dangling));
          yield* materializeCodexShadowHome(layout);
          expect(yield* fs.readDirectory(shadowHome)).not.toContain(dangling);
          expect(yield* fs.readFileString(path.join(shadowHome, "state_5.sqlite-wal"))).toBe(
            "preserved WAL",
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "retains WAL commits from direct and overlay launches while rematerializing",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );
          const open = (home: string) =>
            Effect.acquireRelease(
              Effect.sync(() => new NodeSqlite.DatabaseSync(path.join(home, "state_5.sqlite"))),
              (db) => Effect.sync(() => db.close()),
            );
          yield* Effect.gen(function* () {
            const direct = yield* open(sharedHome);
            direct.exec(
              "PRAGMA journal_mode=WAL; CREATE TABLE writes (value TEXT); INSERT INTO writes VALUES ('direct');",
            );
            yield* materializeCodexShadowHome(layout);
            const environment = withCodexSqliteHome(layout, { CODEX_HOME: shadowHome }, "linux");
            const overlay = yield* open(environment.CODEX_SQLITE_HOME ?? shadowHome);
            overlay.exec("INSERT INTO writes VALUES ('overlay');");
            yield* materializeCodexShadowHome(layout);
            expect(yield* fs.exists(path.join(sharedHome, "state_5.sqlite-wal"))).toBe(true);
            expect(yield* fs.exists(path.join(shadowHome, "state_5.sqlite-wal"))).toBe(false);
            expect(direct.prepare("SELECT value FROM writes ORDER BY rowid").all()).toEqual([
              { value: "direct" },
              { value: "overlay" },
            ]);
          }).pipe(Effect.scoped);
          const reopened = yield* open(sharedHome);
          expect(reopened.prepare("SELECT value FROM writes ORDER BY rowid").all()).toEqual([
            { value: "direct" },
            { value: "overlay" },
          ]);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "requires the legacy writer to stop and checkpoint before a canonical launch",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const sharedDatabase = path.join(sharedHome, "state_5.sqlite");
          const shadowDatabase = path.join(shadowHome, "state_5.sqlite");
          yield* fs.writeFileString(sharedDatabase, "");
          yield* fs.symlink(sharedDatabase, shadowDatabase);
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          yield* Effect.gen(function* () {
            const legacy = yield* Effect.acquireRelease(
              Effect.sync(() => new NodeSqlite.DatabaseSync(shadowDatabase)),
              (db) => Effect.sync(() => db.close()),
            );
            // A writer can have no sidecar yet; even that link must not be switched.
            expect(yield* materializeCodexShadowHome(layout).pipe(Effect.flip)).toBeInstanceOf(
              CodexShadowHomeSqliteRecoveryRequiredError,
            );
            legacy.exec(
              "PRAGMA journal_mode=WAL; CREATE TABLE writes (value TEXT); INSERT INTO writes VALUES ('legacy');",
            );
            expect(yield* materializeCodexShadowHome(layout).pipe(Effect.flip)).toBeInstanceOf(
              CodexShadowHomeSqliteRecoveryRequiredError,
            );
            expect(yield* fs.readLink(shadowDatabase)).toBe(sharedDatabase);
            expect(legacy.prepare("SELECT value FROM writes").all()).toEqual([{ value: "legacy" }]);
          }).pipe(Effect.scoped);
          // Simulate the operator's recovery only after SQLite closed and checkpointed.
          yield* fs.remove(shadowDatabase);
          yield* materializeCodexShadowHome(layout);
          const canonical = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(sharedDatabase)),
            (db) => Effect.sync(() => db.close()),
          );
          canonical.exec("INSERT INTO writes VALUES ('canonical');");
          expect(canonical.prepare("SELECT value FROM writes ORDER BY rowid").all()).toEqual([
            { value: "legacy" },
            { value: "canonical" },
          ]);
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
          yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
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

          expect(sessionsTarget).toBe(path.join(sharedHome, "sessions"));
          expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
          expect(mcpOauthLocksTarget).toBe(path.join(sharedHome, "mcp-oauth-locks"));
          expect(modelsCacheExists).toBe(false);
          expect(authLinkResult._tag).toBe("Failure");
          expect(authContents).toContain("shadow");
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
          const fileSystem = yield* FileSystem.FileSystem;
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
          yield* fileSystem.remove(path.join(shadowHome, "config.toml"));
          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.readLink(path.join(shadowHome, "config.toml"))).toBe(
            path.join(sharedHome, "config.toml"),
          );
        }),
    );

    it.effect("preserves filesystem operation, paths, and cause", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedRoot = yield* makeTempDir("t3code-codex-shared-root-");
        const sharedHome = path.join(sharedRoot, "shared-home");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");
        yield* writeTextFile(sharedHome, "not a directory\n");

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

        expect(error._tag).toBe("CodexShadowHomeFileSystemError");
        if (error._tag !== "CodexShadowHomeFileSystemError") {
          return expect.fail("Expected CodexShadowHomeFileSystemError");
        }
        expect(error).toMatchObject({
          operation: "makeDirectory",
          sharedHomePath: sharedHome,
          effectiveHomePath: shadowHome,
        });
        expect(error.path.startsWith(sharedHome)).toBe(true);
        expect(error.cause).toBeInstanceOf(PlatformError.PlatformError);
        expect(error.message).toBe(
          `Codex shadow home filesystem operation 'makeDirectory' failed for '${error.path}'.`,
        );
      }),
    );
  });
});
