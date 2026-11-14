import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { CodexSettings } from "@t3tools/contracts";
import {
  CodexShadowHomeFileSystemError,
  CodexShadowHomePathConflictError,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
const decodeCodexSettingsValue = Schema.decodeSync(CodexSettings);
const isCodexShadowHomeFileSystemError = Schema.is(CodexShadowHomeFileSystemError);
const CONFLICTS_DIRECTORY = ".t3-shadow-conflicts";

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

const listConflictRuns = Effect.fn("CodexHomeLayout.test.listConflictRuns")(function* (
  shadowHome: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const conflictsPath = path.join(shadowHome, CONFLICTS_DIRECTORY);
  if (!(yield* fileSystem.exists(conflictsPath))) return [];
  return yield* fileSystem.readDirectory(conflictsPath);
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
          expect(yield* listConflictRuns(shadowHome)).toEqual([]);

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

    it.effect.skipIf(!symlinksSupported)(
      "finishes replacing a SQLite family when setup is interrupted mid-move",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          for (const home of [sharedHome, shadowHome]) {
            yield* writeTextFile(path.join(home, "queue_1.sqlite"), "db");
            yield* writeTextFile(path.join(home, "queue_1.sqlite-wal"), "wal");
          }
          const baseRenameStarted = yield* Deferred.make<void>();
          const releaseBaseRename = yield* Deferred.make<void>();
          // The WAL has already moved when the base rename blocks.
          const blockingFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            rename: (fromPath, toPath) =>
              fromPath === path.join(shadowHome, "queue_1.sqlite")
                ? Deferred.succeed(baseRenameStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseBaseRename)),
                    Effect.andThen(fileSystem.rename(fromPath, toPath)),
                  )
                : fileSystem.rename(fromPath, toPath),
          });
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          const setup = yield* materializeCodexShadowHome(layout).pipe(
            Effect.provideService(FileSystem.FileSystem, blockingFileSystem),
            Effect.forkChild,
          );
          yield* Deferred.await(baseRenameStarted);
          setup.interruptUnsafe();
          yield* Deferred.succeed(releaseBaseRename, undefined);
          yield* Fiber.await(setup);

          for (const entryName of ["queue_1.sqlite", "queue_1.sqlite-wal"]) {
            expect(yield* fileSystem.readLink(path.join(shadowHome, entryName))).toBe(
              path.join(sharedHome, entryName),
            );
          }
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "fails setup instead of starting Codex on a SQLite family it could not restore",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          yield* writeTextFile(path.join(sharedHome, "queue_1.sqlite"), "shared db");
          yield* writeTextFile(path.join(sharedHome, "queue_1.sqlite-wal"), "shared wal");
          yield* writeTextFile(path.join(shadowHome, "queue_1.sqlite"), "shadow db");
          yield* writeTextFile(path.join(shadowHome, "queue_1.sqlite-wal"), "shadow wal");
          const failure = PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            description: "Forced failure.",
          });
          // The base cannot move, and the WAL that already moved cannot come back.
          const failingFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            rename: (fromPath, toPath) =>
              fromPath === path.join(shadowHome, "queue_1.sqlite") ||
              fromPath.includes(CONFLICTS_DIRECTORY)
                ? Effect.fail(failure)
                : fileSystem.rename(fromPath, toPath),
          });
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          const error = yield* materializeCodexShadowHome(layout).pipe(
            Effect.provideService(FileSystem.FileSystem, failingFileSystem),
            Effect.flip,
          );

          expect(error).toBeInstanceOf(CodexShadowHomeFileSystemError);
          expect(error).toMatchObject({
            operation: "rename",
            entryName: "queue_1.sqlite-wal",
            targetPath: path.join(shadowHome, "queue_1.sqlite-wal"),
          });
          if (!isCodexShadowHomeFileSystemError(error)) return;
          expect(yield* fileSystem.readFileString(error.path)).toBe("shadow wal");
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
      "moves conflicting shadow files and directories aside, then links the shared entry",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          yield* materializeCodexShadowHome(layout);

          // Codex adds new entries to both homes after the first setup.
          yield* writeTextFile(path.join(sharedHome, "memories_v2.lock"), "shared lock");
          yield* writeTextFile(path.join(shadowHome, "memories_v2.lock"), "shadow lock");
          yield* writeTextFile(path.join(sharedHome, "memories_v2", ".git", "HEAD"), "shared");
          yield* writeTextFile(path.join(shadowHome, "memories_v2", ".git", "HEAD"), "shadow");

          yield* materializeCodexShadowHome(layout);
          yield* materializeCodexShadowHome(layout);

          const runs = yield* listConflictRuns(shadowHome);
          expect(runs).toHaveLength(1);
          const backup = path.join(shadowHome, CONFLICTS_DIRECTORY, runs[0]!);
          expect(yield* fileSystem.readDirectory(backup)).toEqual(
            expect.arrayContaining(["memories_v2", "memories_v2.lock"]),
          );
          expect(yield* fileSystem.readFileString(path.join(backup, "memories_v2.lock"))).toBe(
            "shadow lock",
          );
          expect(
            yield* fileSystem.readFileString(path.join(backup, "memories_v2", ".git", "HEAD")),
          ).toBe("shadow");
          for (const entryName of ["memories_v2.lock", "memories_v2"]) {
            expect(yield* fileSystem.readLink(path.join(shadowHome, entryName))).toBe(
              path.join(sharedHome, entryName),
            );
          }
          expect(yield* fileSystem.readFileString(path.join(sharedHome, "memories_v2.lock"))).toBe(
            "shared lock",
          );
          expect(
            yield* fileSystem.readFileString(path.join(sharedHome, "memories_v2", ".git", "HEAD")),
          ).toBe("shared");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "moves a conflicting SQLite database aside together with its sidecars",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          yield* writeTextFile(path.join(sharedHome, "queue_1.sqlite"), "shared db");
          yield* writeTextFile(path.join(sharedHome, "queue_1.sqlite-wal"), "shared wal");
          yield* writeTextFile(path.join(shadowHome, "queue_1.sqlite"), "shadow db");
          yield* writeTextFile(path.join(shadowHome, "queue_1.sqlite-wal"), "shadow wal");
          // The shared home has no -shm, so nothing would link it, but it must not stay behind.
          yield* writeTextFile(path.join(shadowHome, "queue_1.sqlite-shm"), "shadow shm");
          // Shadow-only databases have nothing to share and stay where they are.
          yield* writeTextFile(path.join(shadowHome, "goals_1.sqlite"), "shadow goals");
          yield* writeTextFile(path.join(shadowHome, "goals_1.sqlite-wal"), "shadow goals wal");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* materializeCodexShadowHome(layout);
          yield* materializeCodexShadowHome(layout);

          const runs = yield* listConflictRuns(shadowHome);
          expect(runs).toHaveLength(1);
          const backup = path.join(shadowHome, CONFLICTS_DIRECTORY, runs[0]!);
          for (const [entryName, contents] of [
            ["queue_1.sqlite", "shadow db"],
            ["queue_1.sqlite-wal", "shadow wal"],
            ["queue_1.sqlite-shm", "shadow shm"],
          ] as const) {
            expect(yield* fileSystem.readFileString(path.join(backup, entryName))).toBe(contents);
          }
          for (const entryName of ["queue_1.sqlite", "queue_1.sqlite-wal"]) {
            expect(yield* fileSystem.readLink(path.join(shadowHome, entryName))).toBe(
              path.join(sharedHome, entryName),
            );
          }
          expect(yield* fileSystem.exists(path.join(shadowHome, "queue_1.sqlite-shm"))).toBe(false);
          expect(yield* fileSystem.readFileString(path.join(sharedHome, "queue_1.sqlite"))).toBe(
            "shared db",
          );
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "goals_1.sqlite"))).toBe(
            "shadow goals",
          );
          expect(
            yield* fileSystem.readFileString(path.join(shadowHome, "goals_1.sqlite-wal")),
          ).toBe("shadow goals wal");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "restores a conflict group and links the rest when inspecting, moving, or linking fails",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          for (const entryName of ["queue_1.sqlite", "queue_1.sqlite-wal", "queue_1.sqlite-shm"]) {
            yield* writeTextFile(path.join(sharedHome, entryName), `shared ${entryName}`);
          }
          yield* writeTextFile(path.join(shadowHome, "queue_1.sqlite"), "shadow db");
          yield* writeTextFile(path.join(shadowHome, "queue_1.sqlite-wal"), "shadow wal");
          yield* writeTextFile(path.join(sharedHome, "cache.json"), "shared");
          yield* writeTextFile(path.join(shadowHome, "cache.json"), "shadow");
          yield* writeTextFile(path.join(sharedHome, "logs_2.sqlite"), "shared logs");
          const failure = (method: string) =>
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method,
              description: "Forced failure.",
            });
          const failingFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            readLink: (linkPath) =>
              linkPath === path.join(shadowHome, "logs_2.sqlite-shm")
                ? Effect.fail(failure("readLink"))
                : fileSystem.readLink(linkPath),
            // The base fails after its WAL has moved, as a file held open on Windows would.
            rename: (fromPath, toPath) =>
              fromPath === path.join(shadowHome, "queue_1.sqlite")
                ? Effect.fail(failure("rename"))
                : fileSystem.rename(fromPath, toPath),
            symlink: (target, link) =>
              link === path.join(shadowHome, "cache.json")
                ? Effect.fail(failure("symlink"))
                : fileSystem.symlink(target, link),
          });
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* materializeCodexShadowHome(layout).pipe(
            Effect.provideService(FileSystem.FileSystem, failingFileSystem),
          );

          expect(yield* fileSystem.readFileString(path.join(shadowHome, "queue_1.sqlite"))).toBe(
            "shadow db",
          );
          expect(
            yield* fileSystem.readFileString(path.join(shadowHome, "queue_1.sqlite-wal")),
          ).toBe("shadow wal");
          expect(yield* fileSystem.exists(path.join(shadowHome, "queue_1.sqlite-shm"))).toBe(false);
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "cache.json"))).toBe(
            "shadow",
          );
          expect(yield* fileSystem.exists(path.join(shadowHome, "logs_2.sqlite"))).toBe(false);
          expect(yield* fileSystem.readLink(path.join(shadowHome, "config.toml"))).toBe(
            path.join(sharedHome, "config.toml"),
          );
        }),
    );
  });
});
