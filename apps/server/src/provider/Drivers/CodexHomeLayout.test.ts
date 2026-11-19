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

const makeShadowLayout = Effect.fn("CodexHomeLayout.test.makeShadowLayout")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  // macOS hands out temp directories through a link, and Windows routing names real paths.
  const sharedHome = yield* fileSystem.realPath(yield* makeTempDir("t3code-codex-shared-"));
  const shadowHome = yield* fileSystem.realPath(yield* makeTempDir("t3code-codex-shadow-"));
  const layout = yield* resolveCodexHomeLayout(
    decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
  );
  return { sharedHome, shadowHome, layout };
});

/** What a launch gets for a SQLite home: on Windows, T3 also pins it as a Codex argument. */
const routedTo = Effect.fn("CodexHomeLayout.test.routedTo")(function* (sqliteHome: string) {
  return (yield* HostProcess.isWindows)
    ? { CODEX_SQLITE_HOME: sqliteHome, T3CODE_CODEX_SQLITE_HOME: sqliteHome }
    : { CODEX_SQLITE_HOME: sqliteHome };
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

          yield* materializeCodexShadowHome(layout, {});
          expect(yield* fileSystem.readFileString(shadowMetadata)).toBe("shadow Finder metadata");
          yield* fileSystem.remove(shadowMetadata);
          yield* materializeCodexShadowHome(layout, {});
          expect(yield* fileSystem.exists(shadowMetadata)).toBe(false);

          yield* writeTextFile(shadowMetadata, "shadow Finder metadata");
          yield* materializeCodexShadowHome(layout, {});
          yield* materializeCodexShadowHome(layout, {});

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

          yield* materializeCodexShadowHome(layout, {});

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

          yield* materializeCodexShadowHome(layout, {});

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

          yield* materializeCodexShadowHome(layout, {});

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

          yield* materializeCodexShadowHome(layout, {});
          expect(yield* fileSystem.exists(threadLock)).toBe(true);

          yield* fileSystem.remove(threadLock);
          yield* materializeCodexShadowHome(layout, {});
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

          yield* materializeCodexShadowHome(layout, {});

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

        const error = yield* materializeCodexShadowHome(layout, {}).pipe(Effect.flip);

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

          const error = yield* materializeCodexShadowHome(layout, {}).pipe(Effect.flip);

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

  describe("SQLite routing", () => {
    it.effect.skipIf(!symlinksSupported)(
      "keeps SQLite out of a fresh shadow and routes it to the shared home",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout } = yield* makeShadowLayout();
          yield* writeTextFile(path.join(sharedHome, "state_5.sqlite"), "db");
          yield* writeTextFile(path.join(sharedHome, "state_5.sqlite-wal"), "wal");

          const environment = yield* materializeCodexShadowHome(layout, { KEEP: "1" });

          expect(environment).toEqual({ KEEP: "1", ...(yield* routedTo(sharedHome)) });
          const shadowEntries = yield* fileSystem.readDirectory(shadowHome);
          expect(shadowEntries.filter((entry) => entry.includes(".sqlite"))).toEqual([]);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "accepts legacy SQLite links with empty or index-only sidecars",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout } = yield* makeShadowLayout();
          // What Windows leaves behind: the shared Codex has sidecars of its own, and SQLite put an
          // index and an empty WAL beside each link.
          const databases = [
            "goals_1.sqlite",
            "memories_1.sqlite",
            "memories_v2_1.sqlite",
            "state_5.sqlite",
          ];
          for (const database of databases) {
            yield* writeTextFile(path.join(sharedHome, database), "db");
            yield* writeTextFile(path.join(sharedHome, `${database}-wal`), "shared wal");
            yield* writeTextFile(path.join(sharedHome, `${database}-shm`), "shared index");
            yield* fileSystem.symlink(
              path.join(sharedHome, database),
              path.join(shadowHome, database),
            );
            yield* writeTextFile(path.join(shadowHome, `${database}-wal`), "");
            yield* writeTextFile(path.join(shadowHome, `${database}-shm`), "index");
          }

          const environment = yield* materializeCodexShadowHome(layout, {});

          expect(environment.CODEX_SQLITE_HOME).toBe(sharedHome);
          for (const database of databases) {
            expect(yield* fileSystem.readLink(path.join(shadowHome, database))).toBe(
              path.join(sharedHome, database),
            );
            expect(yield* fileSystem.readFileString(path.join(shadowHome, `${database}-wal`))).toBe(
              "",
            );
            expect(yield* fileSystem.readFileString(path.join(shadowHome, `${database}-shm`))).toBe(
              "index",
            );
          }
        }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a shadow WAL holding data for a linked database without touching it",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout } = yield* makeShadowLayout();
          const shadowWal = path.join(shadowHome, "state_5.sqlite-wal");
          yield* writeTextFile(path.join(sharedHome, "state_5.sqlite"), "db");
          yield* fileSystem.symlink(
            path.join(sharedHome, "state_5.sqlite"),
            path.join(shadowHome, "state_5.sqlite"),
          );
          yield* writeTextFile(shadowWal, "uncheckpointed frames");

          const error = yield* materializeCodexShadowHome(layout, {}).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CodexShadowHomeSqliteConflictError);
          expect(error).toMatchObject({ entryName: "state_5.sqlite-wal" });
          // Naming the shared home outright strands that WAL just the same.
          expect(
            yield* materializeCodexShadowHome(layout, { CODEX_SQLITE_HOME: sharedHome }).pipe(
              Effect.flip,
              Effect.provideService(HostProcess.Platform, "win32"),
            ),
          ).toMatchObject({
            _tag: "CodexShadowHomeSqliteConflictError",
            entryName: "state_5.sqlite-wal",
          });
          expect(yield* fileSystem.readFileString(shadowWal)).toBe("uncheckpointed frames");
          expect(yield* fileSystem.exists(path.join(shadowHome, "sessions"))).toBe(false);
          // Windows resolves a rooted path onto the working directory's drive.
          expect(
            yield* materializeCodexShadowHome(layout, { CODEX_SQLITE_HOME: " /elsewhere " }),
          ).toEqual(yield* routedTo(path.resolve("/elsewhere")));
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "keeps a shadow's own databases on POSIX and refuses only one the shared home also has",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout } = yield* makeShadowLayout();
          yield* writeTextFile(path.join(shadowHome, "state_5.sqlite"), "private db");
          yield* writeTextFile(path.join(shadowHome, "state_5.sqlite-wal"), "private wal");

          expect((yield* codexHomeEnvironment(layout, {})).CODEX_SQLITE_HOME).toBe(shadowHome);

          yield* writeTextFile(path.join(sharedHome, "goals_1.sqlite"), "shared db");
          yield* writeTextFile(path.join(sharedHome, "goals_1.sqlite-wal"), "shared wal");
          const environment = yield* materializeCodexShadowHome(layout, {});
          expect(environment.CODEX_SQLITE_HOME).toBe(shadowHome);
          expect(yield* fileSystem.readLink(path.join(shadowHome, "goals_1.sqlite"))).toBe(
            path.join(sharedHome, "goals_1.sqlite"),
          );
          expect(yield* fileSystem.exists(path.join(shadowHome, "goals_1.sqlite-wal"))).toBe(false);
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "state_5.sqlite"))).toBe(
            "private db",
          );
          // POSIX SQLite follows the link itself, so naming this shadow outright stays allowed.
          expect(
            (yield* codexHomeEnvironment(layout, { CODEX_SQLITE_HOME: shadowHome }))
              .CODEX_SQLITE_HOME,
          ).toBe(shadowHome);

          yield* writeTextFile(path.join(sharedHome, "state_5.sqlite"), "shared db");
          const error = yield* codexHomeEnvironment(layout, {}).pipe(Effect.flip);
          expect(error).toBeInstanceOf(CodexShadowHomeSqliteConflictError);
        }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
    );

    // regression: #24486 a Windows shadow with its own state_5.sqlite was routed to itself with the
    // shared goals_1.sqlite linked in, so it and a shared-home Codex each kept a WAL for goals.
    it.effect.skipIf(!symlinksSupported)(
      "never lets a Windows shadow reach a shared database through a link",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout } = yield* makeShadowLayout();
          const sharedGoals = path.join(sharedHome, "goals_1.sqlite");
          const shadowGoals = path.join(shadowHome, "goals_1.sqlite");
          const goalEntries = (home: string) =>
            fileSystem
              .readDirectory(home)
              .pipe(
                Effect.map((entries) =>
                  entries.filter((entry) => entry.startsWith("goals_1.sqlite")).toSorted(),
                ),
              );
          // One helper prepares the shadow and the other only resolves; they must agree.
          const launch = (environment: NodeJS.ProcessEnv) =>
            Effect.all([
              materializeCodexShadowHome(layout, environment).pipe(Effect.result),
              codexHomeEnvironment(layout, environment).pipe(Effect.result),
            ]);
          yield* writeTextFile(path.join(shadowHome, "state_5.sqlite"), "private db");
          yield* writeTextFile(path.join(shadowHome, "state_5.sqlite-wal"), "private wal");

          // With no shared databases there is nothing to link, so the shadow keeps its own.
          expect((yield* materializeCodexShadowHome(layout, {})).CODEX_SQLITE_HOME).toBe(
            shadowHome,
          );

          yield* writeTextFile(sharedGoals, "shared db");
          for (const refused of yield* launch({})) {
            expect(refused).toMatchObject({
              _tag: "Failure",
              failure: {
                _tag: "CodexShadowHomeSqliteConflictError",
                sharedHomePath: sharedHome,
                effectiveHomePath: shadowHome,
                entryName: "state_5.sqlite",
                sharedEntryName: "goals_1.sqlite",
              },
            });
          }
          expect(yield* goalEntries(shadowHome)).toEqual([]);
          // The shadow may be named outright while it holds only databases of its own.
          for (const kept of yield* launch({ CODEX_SQLITE_HOME: shadowHome })) {
            expect(kept).toMatchObject({ success: { CODEX_SQLITE_HOME: shadowHome } });
          }
          expect(yield* goalEntries(shadowHome)).toEqual([]);

          // A build with the old fallback may already have left the link it made.
          yield* fileSystem.symlink(sharedGoals, shadowGoals);
          const shadowAlias = path.join(yield* makeTempDir("t3code-codex-alias-"), "shadow");
          yield* fileSystem.symlink(shadowHome, shadowAlias);
          for (const environment of [
            {},
            { CODEX_SQLITE_HOME: shadowHome },
            { CODEX_SQLITE_HOME: shadowAlias },
          ]) {
            for (const refused of yield* launch(environment)) {
              expect(refused).toMatchObject({
                _tag: "Failure",
                failure: { _tag: "CodexShadowHomeSqliteConflictError" },
              });
            }
          }
          expect(
            (yield* codexHomeEnvironment(layout, { CODEX_SQLITE_HOME: shadowHome }).pipe(
              Effect.flip,
            )).message,
          ).toContain(`'${shadowHome}', where 'goals_1.sqlite' is a link`);

          // Naming the shared home is the way through: every writer then opens one path, so one WAL.
          const routed = yield* materializeCodexShadowHome(layout, {
            CODEX_SQLITE_HOME: sharedHome,
          });
          expect(routed).toEqual({
            CODEX_SQLITE_HOME: sharedHome,
            T3CODE_CODEX_SQLITE_HOME: sharedHome,
          });
          expect(yield* codexHomeEnvironment(layout, { CODEX_SQLITE_HOME: sharedHome })).toEqual(
            routed,
          );
          expect(yield* goalEntries(shadowHome)).toEqual(["goals_1.sqlite"]);
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "state_5.sqlite"))).toBe(
            "private db",
          );
          expect(
            yield* fileSystem.readFileString(path.join(shadowHome, "state_5.sqlite-wal")),
          ).toBe("private wal");
        }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses on Windows a shadow that keeps its own database beside a dangling legacy link",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout } = yield* makeShadowLayout();
          yield* writeTextFile(path.join(shadowHome, "state_5.sqlite"), "private db");
          yield* fileSystem.symlink(
            path.join(sharedHome, "goals_1.sqlite"),
            path.join(shadowHome, "goals_1.sqlite"),
          );

          const error = yield* materializeCodexShadowHome(layout, {}).pipe(Effect.flip);

          expect(error).toMatchObject({
            _tag: "CodexShadowHomeSqliteConflictError",
            entryName: "state_5.sqlite",
            sharedEntryName: "goals_1.sqlite",
          });
          expect(yield* fileSystem.exists(path.join(sharedHome, "goals_1.sqlite"))).toBe(false);
        }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
    );

    it.effect.skipIf(!symlinksSupported)(
      "does not link a database the shared home gains after the Windows check",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout } = yield* makeShadowLayout();
          yield* writeTextFile(path.join(shadowHome, "state_5.sqlite"), "private db");
          let checked = false;
          const environment = yield* materializeCodexShadowHome(layout, {}).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fileSystem,
              readDirectory: (directory, options) =>
                directory === sharedHome && !checked
                  ? fileSystem.readDirectory(directory, options).pipe(
                      Effect.tap(() => {
                        checked = true;
                        return fileSystem.writeFileString(
                          path.join(sharedHome, "goals_1.sqlite"),
                          "shared db",
                        );
                      }),
                    )
                  : fileSystem.readDirectory(directory, options),
            }),
          );

          expect(checked).toBe(true);
          expect(environment.CODEX_SQLITE_HOME).toBe(shadowHome);
          expect(yield* fileSystem.exists(path.join(shadowHome, "goals_1.sqlite"))).toBe(false);
        }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
    );

    // regression: #24486 Codex ranks sqlite_home above CODEX_SQLITE_HOME, so a shadow whose config or
    // launch args named it still opened the linked database while T3 reported the shared home.
    it.effect.skipIf(!symlinksSupported)(
      "pins the Windows SQLite home and refuses a sqlite_home setting that would outrank it",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout } = yield* makeShadowLayout();
          const sharedConfig = path.join(sharedHome, "config.toml");
          const shadowConfig = path.join(shadowHome, "config.toml");
          yield* writeTextFile(path.join(sharedHome, "goals_1.sqlite"), "db");
          yield* fileSystem.symlink(
            path.join(sharedHome, "goals_1.sqlite"),
            path.join(shadowHome, "goals_1.sqlite"),
          );
          const launch = (launchArgs?: string) =>
            Effect.all([
              materializeCodexShadowHome(layout, {}, launchArgs).pipe(Effect.result),
              codexHomeEnvironment(layout, {}, launchArgs).pipe(Effect.result),
            ]);

          for (const launched of yield* launch("--strict-config")) {
            expect(launched).toMatchObject({
              success: { CODEX_SQLITE_HOME: sharedHome, T3CODE_CODEX_SQLITE_HOME: sharedHome },
            });
          }
          for (const launchArgs of [
            `-c sqlite_home="${shadowHome}"`,
            `--config=sqlite_home='${shadowHome}'`,
            `-csqlite_home=${shadowHome}`,
          ]) {
            for (const refused of yield* launch(launchArgs)) {
              expect(refused).toMatchObject({
                _tag: "Failure",
                failure: { _tag: "CodexShadowHomeSqliteSettingError", setting: "launchArgs" },
              });
            }
          }

          yield* writeTextFile(shadowConfig, `model = "gpt"\nsqlite_home = "${shadowHome}"\n`);
          for (const refused of yield* launch()) {
            expect(refused).toMatchObject({
              _tag: "Failure",
              failure: {
                _tag: "CodexShadowHomeSqliteSettingError",
                setting: "configFile",
                value: shadowConfig,
              },
            });
          }
          // POSIX SQLite opens a link by its target, so Codex's own precedence is safe there.
          expect(
            yield* codexHomeEnvironment(layout, {}).pipe(
              Effect.provideService(HostProcess.Platform, "linux"),
            ),
          ).toEqual({ CODEX_SQLITE_HOME: sharedHome });

          // A fresh shadow links the shared config in, so that file counts before the link exists.
          yield* fileSystem.remove(shadowConfig);
          yield* writeTextFile(
            sharedConfig,
            `x = true\n  "sqlite_home"='${shadowHome}'\n[features]\ny = true\n`,
          );
          for (const refused of yield* launch()) {
            expect(refused).toMatchObject({
              _tag: "Failure",
              failure: { setting: "configFile", value: sharedConfig },
            });
          }
          expect(yield* fileSystem.exists(shadowConfig)).toBe(false);

          yield* writeTextFile(sharedConfig, `# sqlite_home = "${shadowHome}"\nmodel = "gpt"\n`);
          for (const launched of yield* launch()) {
            expect(launched).toMatchObject({ success: { CODEX_SQLITE_HOME: sharedHome } });
          }
        }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
    );

    // regression: #24486 the check matched any `sqlite_home =` text, so Windows refused a shadow whose
    // MCP server had a variable of that name, or whose instructions mentioned the setting.
    it.effect.skipIf(!symlinksSupported)(
      "launches a Windows shadow whose sqlite_home is not Codex's own setting",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout } = yield* makeShadowLayout();
          yield* writeTextFile(path.join(sharedHome, "goals_1.sqlite"), "db");
          yield* fileSystem.symlink(
            path.join(sharedHome, "goals_1.sqlite"),
            path.join(shadowHome, "goals_1.sqlite"),
          );
          const expectLaunch = Effect.fn(function* (launchArgs?: string) {
            for (const run of [materializeCodexShadowHome, codexHomeEnvironment]) {
              expect(yield* run(layout, {}, launchArgs).pipe(Effect.result)).toMatchObject({
                success: { CODEX_SQLITE_HOME: sharedHome, T3CODE_CODEX_SQLITE_HOME: sharedHome },
              });
            }
          });

          const shadowConfig = path.join(shadowHome, "config.toml");
          yield* writeTextFile(
            shadowConfig,
            'developer_instructions = """\nKeep this text.\nsqlite_home = "somewhere"\n"""\nmodel = "gpt"\n',
          );
          yield* expectLaunch();
          yield* expectLaunch(`-c 'mcp_servers.example.env.sqlite_home="MCP-only"'`);
          yield* expectLaunch(`--config 'developer_instructions="Leave sqlite_home=unset"'`);

          yield* fileSystem.remove(shadowConfig);
          yield* writeTextFile(
            path.join(sharedHome, "config.toml"),
            '[mcp_servers.example]\ncommand = "echo"\n[mcp_servers.example.env]\nsqlite_home = "an MCP-only value"\n',
          );
          yield* expectLaunch();
        }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
    );

    // regression: #24486 a relative CODEX_SQLITE_HOME skipped the Windows check, and each launch
    // directory resolved it differently.
    it.effect.skipIf(!symlinksSupported)("refuses a relative Windows CODEX_SQLITE_HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { layout } = yield* makeShadowLayout();
        // Written out, not derived from the temp shadow: on Windows a temp directory on another
        // drive has no path relative to the working directory.
        const relativeShadow = path.join("codex", "shadow");

        for (const run of [materializeCodexShadowHome, codexHomeEnvironment]) {
          expect(
            yield* run(layout, { CODEX_SQLITE_HOME: relativeShadow }).pipe(Effect.flip),
          ).toMatchObject({
            _tag: "CodexShadowHomeSqliteSettingError",
            setting: "relativeEnvironment",
            value: relativeShadow,
          });
        }
      }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
    );

    // regression: #24486 only the exact spelling of the shared home skipped the link check, so an
    // alias of it was inspected, and every spelling was passed to Codex as written.
    it.effect.skipIf(!symlinksSupported)(
      "treats every spelling of the shared home as the shared home on Windows",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { sharedHome, shadowHome, layout } = yield* makeShadowLayout();
          // Left unset, T3 routes to the shared home without inspecting what it holds.
          const elsewhere = path.join(
            yield* makeTempDir("t3code-codex-elsewhere-"),
            "goals.sqlite",
          );
          yield* writeTextFile(elsewhere, "db");
          yield* fileSystem.symlink(elsewhere, path.join(sharedHome, "goals_1.sqlite"));
          const alias = path.join(yield* makeTempDir("t3code-codex-alias-"), "shared");
          yield* fileSystem.symlink(sharedHome, alias);

          for (const spelling of [alias, `${sharedHome}${path.sep}`, sharedHome.toUpperCase()]) {
            for (const run of [materializeCodexShadowHome, codexHomeEnvironment]) {
              expect((yield* run(layout, { CODEX_SQLITE_HOME: spelling })).CODEX_SQLITE_HOME).toBe(
                sharedHome,
              );
            }
          }
          // Any other directory is named by its real path, however the override reached it.
          const shadowAlias = path.join(yield* makeTempDir("t3code-codex-alias-"), "shadow");
          yield* fileSystem.symlink(shadowHome, shadowAlias);
          expect(
            (yield* codexHomeEnvironment(layout, { CODEX_SQLITE_HOME: shadowAlias }))
              .CODEX_SQLITE_HOME,
          ).toBe(shadowHome);
        }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
    );
  });
});
