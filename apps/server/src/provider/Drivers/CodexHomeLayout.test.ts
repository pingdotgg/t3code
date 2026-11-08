// @effect-diagnostics nodeBuiltinImport:off -- SQLite is used only in disposable test homes.
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CodexSettings } from "@t3tools/contracts";
import {
  CodexShadowHomeEntryConflictError,
  CodexShadowHomePathConflictError,
  CodexShadowHomeSqliteConflictError,
  codexHomeEnvironment,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
const windowsHost = HostProcess.Platform.defaultValue() === "win32";
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

  describe("materializeCodexShadowHome", () => {
    it.effect.each(["shadow-within-shared", "shared-within-shadow"] as const)(
      "refuses overlapping home directories before making links (%s)",
      (overlap) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeTempDir("t3code-codex-overlap-");
          const sharedHome =
            overlap === "shadow-within-shared"
              ? path.join(root, "shared")
              : path.join(root, "shadow", "shared");
          const shadowHome =
            overlap === "shadow-within-shared"
              ? path.join(root, "shared", "shadow")
              : path.join(root, "shadow");
          const config = decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          });
          const layout = yield* resolveCodexHomeLayout(config);

          const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CodexShadowHomePathConflictError);
          expect(yield* fileSystem.exists(path.join(shadowHome, "sessions"))).toBe(false);
          expect(yield* fileSystem.exists(path.join(sharedHome, "sessions"))).toBe(false);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses homes that point to the same directory through a symlink alias",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeTempDir("t3code-codex-home-alias-");
          const sharedHome = path.join(root, "shared");
          const shadowHome = path.join(root, "alias-to-shared");
          yield* fileSystem.makeDirectory(sharedHome);
          yield* fileSystem.symlink(sharedHome, shadowHome);
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CodexShadowHomePathConflictError);
          expect(yield* fileSystem.readDirectory(sharedHome)).toEqual([]);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects a missing shadow child beneath an alias of the shared home",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeTempDir("t3code-codex-missing-alias-");
          const sharedHome = path.join(root, "shared");
          const aliasedParent = path.join(root, "shared-alias");
          yield* fileSystem.makeDirectory(sharedHome);
          yield* fileSystem.symlink(sharedHome, aliasedParent);
          const shadowHome = path.join(aliasedParent, "fresh-shadow");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CodexShadowHomePathConflictError);
          expect(yield* fileSystem.exists(path.join(sharedHome, "fresh-shadow"))).toBe(false);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "materializes the same fresh shadow safely under concurrent setup",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeTempDir("t3code-codex-materialize-race-");
          const sharedHome = path.join(root, "shared");
          const shadowHome = path.join(root, "shadow");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          const outcomes = yield* Effect.all(
            Array.from({ length: 8 }, () => materializeCodexShadowHome(layout).pipe(Effect.exit)),
            { concurrency: "unbounded" },
          );
          expect(outcomes.map((outcome) => outcome._tag)).toEqual(Array(8).fill("Success"));
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
          `Codex shadow home path '${sharedHome}' and shared home path '${sharedHome}' must be separate, non-overlapping directories (including filesystem aliases).`,
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

    it.effect.skipIf(!symlinksSupported)(
      "refuses a dirty legacy SQLite overlay before materialization mutates other entries",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const database = path.join(sharedHome, "thread_history_1.sqlite");
          const linkedDatabase = path.join(shadowHome, "thread_history_1.sqlite");
          const sidecar = path.join(shadowHome, "thread_history_1.sqlite-shm");
          const modelsCache = path.join(shadowHome, "models_cache.json");
          const sharedModelsCache = path.join(sharedHome, "models_cache.json");
          yield* writeTextFile(database, "shared-database");
          yield* writeTextFile(sharedModelsCache, "shared-cache");
          yield* fileSystem.symlink(database, linkedDatabase);
          yield* fileSystem.symlink(sharedModelsCache, modelsCache);
          yield* writeTextFile(sidecar, "shadow-sidecar");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CodexShadowHomeSqliteConflictError);
          expect(yield* fileSystem.readLink(linkedDatabase)).toBe(database);
          expect(yield* fileSystem.readLink(modelsCache)).toBe(sharedModelsCache);
          expect(yield* fileSystem.readFileString(sidecar)).toBe("shadow-sidecar");
          expect(yield* fileSystem.exists(path.join(sharedHome, "sessions"))).toBe(false);
        }),
    );
  });

  describe("codexHomeEnvironment", () => {
    it.effect.skipIf(!symlinksSupported)(
      "routes clean shadow homes to the shared SQLite directory without mirroring databases",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          yield* writeTextFile(path.join(sharedHome, "thread_history_1.sqlite"), "database");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* materializeCodexShadowHome(layout);
          const environment = yield* codexHomeEnvironment(layout, {});

          expect(environment.CODEX_SQLITE_HOME).toBe(sharedHome);
          expect(yield* fileSystem.exists(path.join(shadowHome, "thread_history_1.sqlite"))).toBe(
            false,
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a clean legacy SQLite link instead of silently redirecting it",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const database = path.join(sharedHome, "state_5.sqlite");
          const linkedDatabase = path.join(shadowHome, "state_5.sqlite");
          yield* writeTextFile(database, "shared-database");
          yield* fileSystem.symlink(database, linkedDatabase);
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CodexShadowHomeSqliteConflictError);
          expect(error).toMatchObject({ entryName: "state_5.sqlite" });
          expect(yield* fileSystem.readLink(linkedDatabase)).toBe(database);
          expect(yield* fileSystem.readFileString(database)).toBe("shared-database");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a legacy SQLite link that points outside the shared home",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const otherHome = yield* makeTempDir("t3code-codex-other-");
          const entryName = "state_5.sqlite";
          const wrongTarget = path.join(otherHome, entryName);
          const linkedDatabase = path.join(shadowHome, entryName);
          yield* writeTextFile(wrongTarget, "other-database");
          yield* fileSystem.symlink(wrongTarget, linkedDatabase);
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          const error = yield* codexHomeEnvironment(layout, {}).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CodexShadowHomeSqliteConflictError);
          expect(error).toMatchObject({ entryName });
          expect(yield* fileSystem.readLink(linkedDatabase)).toBe(wrongTarget);
        }),
    );

    it.effect("defaults a blank SQLite override to the canonical shared home", () =>
      Effect.gen(function* () {
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );

        const environment = yield* codexHomeEnvironment(layout, { CODEX_SQLITE_HOME: "   " });

        expect(environment.CODEX_SQLITE_HOME).toBe(sharedHome);
      }),
    );

    it.effect("preserves an explicit nonblank SQLite override", () =>
      Effect.gen(function* () {
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
        const customHome = yield* makeTempDir("t3code-codex-custom-sqlite-");
        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );

        const environment = yield* codexHomeEnvironment(layout, {
          CODEX_SQLITE_HOME: `  ${customHome}  `,
        });

        expect(environment.CODEX_SQLITE_HOME).toBe(customHome);
      }),
    );

    it.effect(
      "materialization honors an explicit SQLite override without deleting dormant sidecars",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const customHome = yield* makeTempDir("t3code-codex-custom-sqlite-");
          const sidecar = path.join(shadowHome, "state_5.sqlite-wal");
          yield* writeTextFile(sidecar, "legacy-wal");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          const launchEnvironment = { CODEX_SQLITE_HOME: customHome };

          yield* materializeCodexShadowHome(layout, launchEnvironment);
          const environment = yield* codexHomeEnvironment(layout, launchEnvironment);

          expect(environment.CODEX_SQLITE_HOME).toBe(customHome);
          expect(yield* fileSystem.readFileString(sidecar)).toBe("legacy-wal");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "explicit SQLite overrides still refuse legacy database symlinks",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const customHome = yield* makeTempDir("t3code-codex-custom-sqlite-");
          const database = path.join(sharedHome, "state_5.sqlite");
          const linkedDatabase = path.join(shadowHome, "state_5.sqlite");
          yield* writeTextFile(database, "shared-database");
          yield* fileSystem.symlink(database, linkedDatabase);
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          const error = yield* materializeCodexShadowHome(layout, {
            CODEX_SQLITE_HOME: customHome,
          }).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CodexShadowHomeSqliteConflictError);
          expect(error).toMatchObject({ entryName: "state_5.sqlite" });
          expect(yield* fileSystem.readLink(linkedDatabase)).toBe(database);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a legacy linked database with a shadow-local SHM without changing either file",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const databaseName = "thread_history_1.sqlite";
          const database = path.join(sharedHome, databaseName);
          const linkedDatabase = path.join(shadowHome, databaseName);
          const sidecar = path.join(shadowHome, `${databaseName}-shm`);
          yield* writeTextFile(database, "shared-database");
          yield* fileSystem.symlink(database, linkedDatabase);
          yield* writeTextFile(sidecar, "shadow-sidecar");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          const error = yield* codexHomeEnvironment(layout, {}).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CodexShadowHomeSqliteConflictError);
          expect(error).toMatchObject({ entryName: databaseName });
          expect(yield* fileSystem.readLink(linkedDatabase)).toBe(database);
          expect(yield* fileSystem.readFileString(sidecar)).toBe("shadow-sidecar");
          expect(yield* fileSystem.readFileString(database)).toBe("shared-database");
        }),
    );

    it.effect.skipIf(!symlinksSupported || !windowsHost)(
      "preserves a real uncheckpointed shadow WAL when rejecting a legacy linked database",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const database = path.join(sharedHome, "thread_history_1.sqlite");
          const linkedDatabase = path.join(shadowHome, "thread_history_1.sqlite");
          yield* Effect.sync(() => new NodeSqlite.DatabaseSync(database).close());
          yield* fileSystem.symlink(database, linkedDatabase);
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* Effect.gen(function* () {
            const writer = yield* Effect.acquireRelease(
              Effect.sync(() => new NodeSqlite.DatabaseSync(linkedDatabase)),
              (db) => Effect.sync(() => db.close()),
            );
            writer.exec(
              "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE writes (value TEXT); INSERT INTO writes VALUES ('legacy');",
            );
            const wal = path.join(shadowHome, "thread_history_1.sqlite-wal");
            const shm = path.join(shadowHome, "thread_history_1.sqlite-shm");
            const walBefore = yield* fileSystem.readFile(wal);
            const shmBefore = yield* fileSystem.readFile(shm);
            const databaseBefore = yield* fileSystem.readFile(database);

            const error = yield* codexHomeEnvironment(layout, {}).pipe(Effect.flip);

            expect(error).toBeInstanceOf(CodexShadowHomeSqliteConflictError);
            expect(yield* fileSystem.readFile(wal)).toEqual(walBefore);
            expect(yield* fileSystem.readFile(shm)).toEqual(shmBefore);
            expect(yield* fileSystem.readFile(database)).toEqual(databaseBefore);
            expect(yield* fileSystem.readLink(linkedDatabase)).toBe(database);
            expect(writer.prepare("SELECT value FROM writes").all()).toEqual([{ value: "legacy" }]);
          }).pipe(Effect.scoped);
        }),
    );

    it.effect(
      "keeps an existing private SQLite family in the shadow home instead of discarding its WAL",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          yield* writeTextFile(path.join(shadowHome, "state_5.sqlite"), "private-database");
          yield* writeTextFile(path.join(shadowHome, "state_5.sqlite-wal"), "private-wal");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          const environment = yield* codexHomeEnvironment(layout, {});

          expect(environment.CODEX_SQLITE_HOME).toBe(shadowHome);
        }),
    );

    it.effect(
      "refuses mixed shared and private SQLite state instead of silently choosing the shadow",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const sharedDatabase = path.join(sharedHome, "state_5.sqlite");
          const privateDatabase = path.join(shadowHome, "logs_2.sqlite");
          yield* writeTextFile(sharedDatabase, "shared-state");
          yield* writeTextFile(privateDatabase, "private-logs");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          const error = yield* codexHomeEnvironment(layout, {}).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CodexShadowHomeSqliteConflictError);
          expect(error).toMatchObject({ entryName: "logs_2.sqlite" });
          expect(yield* fileSystem.readFileString(sharedDatabase)).toBe("shared-state");
          expect(yield* fileSystem.readFileString(privateDatabase)).toBe("private-logs");
        }),
    );

    it.effect("rejects mixed SQLite state before materialization modifies either home", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
        const sharedDatabase = path.join(sharedHome, "state_5.sqlite");
        const privateDatabase = path.join(shadowHome, "logs_2.sqlite");
        yield* writeTextFile(sharedDatabase, "shared-state");
        yield* writeTextFile(privateDatabase, "private-logs");
        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );

        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

        expect(error).toBeInstanceOf(CodexShadowHomeSqliteConflictError);
        expect(yield* fileSystem.readFileString(sharedDatabase)).toBe("shared-state");
        expect(yield* fileSystem.readFileString(privateDatabase)).toBe("private-logs");
        expect(yield* fileSystem.exists(path.join(sharedHome, "sessions"))).toBe(false);
        expect(yield* fileSystem.exists(path.join(shadowHome, "sessions"))).toBe(false);
      }),
    );

    it.effect(
      "lets an explicit SQLite override resolve otherwise mixed regular state without mutation",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const customHome = yield* makeTempDir("t3code-codex-custom-sqlite-");
          const sharedDatabase = path.join(sharedHome, "state_5.sqlite");
          const privateDatabase = path.join(shadowHome, "logs_2.sqlite");
          yield* writeTextFile(sharedDatabase, "shared-state");
          yield* writeTextFile(privateDatabase, "private-logs");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          const environment = yield* codexHomeEnvironment(layout, {
            CODEX_SQLITE_HOME: customHome,
          });

          expect(environment.CODEX_SQLITE_HOME).toBe(customHome);
          expect(yield* fileSystem.readFileString(sharedDatabase)).toBe("shared-state");
          expect(yield* fileSystem.readFileString(privateDatabase)).toBe("private-logs");
        }),
    );

    it.effect("refuses an orphan shadow SQLite sidecar rather than silently abandoning it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
        yield* writeTextFile(path.join(shadowHome, "goals_1.SQLITE-WAL"), "orphan-wal");
        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );

        const error = yield* codexHomeEnvironment(layout, {}).pipe(Effect.flip);

        expect(error).toBeInstanceOf(CodexShadowHomeSqliteConflictError);
        expect(error).toMatchObject({ entryName: "goals_1.SQLITE-WAL" });
      }),
    );
  });
});
