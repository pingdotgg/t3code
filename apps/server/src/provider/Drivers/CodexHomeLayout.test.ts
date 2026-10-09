// @effect-diagnostics nodeBuiltinImport:off - Effect's symlink cannot make the junctions these tests plant.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { CodexSettings } from "@t3tools/contracts";
import {
  CodexShadowHomeEntryConflictError,
  CodexShadowHomePathConflictError,
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

const markerName = ".t3-local-files";

/** Fails every symlink the way Windows does without Developer Mode. */
const withRefusedSymlinks =
  (platform: NodeJS.Platform) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return yield* effect.pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.FileSystem.of({
            ...fileSystem,
            symlink: (_fromPath, toPath) =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "symlink",
                  syscall: "symlink",
                  pathOrDescriptor: toPath,
                  cause: Object.assign(new Error("EPERM: operation not permitted, symlink"), {
                    code: "EPERM",
                  }),
                }),
              ),
          }),
        ),
        Effect.provideService(HostProcessPlatform, platform),
      );
    });

/** A Windows host where a symlink would succeed, so attempting one fails the test. */
const onWindowsExpectingNoSymlink = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* effect.pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({
          ...fileSystem,
          symlink: () => Effect.die(new Error("a marked shadow home attempted a symlink")),
        }),
      ),
      Effect.provideService(HostProcessPlatform, "win32"),
    );
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

  describe("materializeCodexShadowHome", () => {
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

    describe("when Windows refuses symlinks", () => {
      it.effect("links directories with junctions and keeps files local", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          yield* writeTextFile(path.join(sharedHome, "sessions", "rollout.jsonl"), "{}\n");
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(sharedHome, "auth.json"), '{"shared":true}\n');
          yield* writeTextFile(path.join(shadowHome, "config.toml"), 'model = "local"\n');
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout).pipe(withRefusedSymlinks("win32"));

          yield* fileSystem.writeFileString(
            path.join(shadowHome, "sessions", "written-through-shadow.jsonl"),
            '{"through":"shadow"}\n',
          );
          const sessionsTarget = yield* fileSystem.readLink(path.join(shadowHome, "sessions"));
          const writtenThroughShadow = yield* fileSystem.readFileString(
            path.join(sharedHome, "sessions", "written-through-shadow.jsonl"),
          );
          const sharedConfig = yield* fileSystem.readFileString(
            path.join(sharedHome, "config.toml"),
          );
          const shadowConfig = yield* fileSystem.readFileString(
            path.join(shadowHome, "config.toml"),
          );
          const shadowAuth = yield* fileSystem.readFileString(path.join(shadowHome, "auth.json"));
          const markerExists = yield* fileSystem.exists(path.join(shadowHome, markerName));

          expect(sessionsTarget).toBe(path.join(sharedHome, "sessions"));
          expect(writtenThroughShadow).toBe('{"through":"shadow"}\n');
          expect(sharedConfig).toBe('model = "gpt-5-codex"\n');
          expect(shadowConfig).toBe('model = "local"\n');
          expect(shadowAuth).toBe('{"shadow":true}\n');
          expect(markerExists).toBe(true);
        }),
      );

      it.effect(
        "stays usable once Codex has written its own files, even after symlinks become available",
        () =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const sharedHome = yield* makeTempDir("t3code-codex-shared-");
            const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
            const shadowHome = path.join(shadowRoot, "shadow");

            yield* writeTextFile(path.join(sharedHome, "state_5.sqlite"), "shared state\n");
            yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');

            const layout = yield* resolveCodexHomeLayout(
              decodeCodexSettings({
                homePath: sharedHome,
                shadowHomePath: shadowHome,
              }),
            );
            const expectBothCopiesIntact = Effect.gen(function* () {
              expect(
                yield* fileSystem.readFileString(path.join(sharedHome, "state_5.sqlite")),
              ).toBe("shared state\n");
              expect(
                yield* fileSystem.readFileString(path.join(shadowHome, "state_5.sqlite")),
              ).toBe("shadow state\n");
              expect(yield* fileSystem.readFileString(path.join(sharedHome, "config.toml"))).toBe(
                'model = "gpt-5-codex"\n',
              );
              expect(yield* fileSystem.readFileString(path.join(shadowHome, "config.toml"))).toBe(
                'model = "local"\n',
              );
            });

            yield* materializeCodexShadowHome(layout).pipe(withRefusedSymlinks("win32"));

            yield* writeTextFile(path.join(shadowHome, "state_5.sqlite"), "shadow state\n");
            yield* writeTextFile(path.join(shadowHome, "config.toml"), 'model = "local"\n');
            yield* writeTextFile(path.join(sharedHome, "history.jsonl"), "{}\n");

            yield* materializeCodexShadowHome(layout).pipe(withRefusedSymlinks("win32"));
            yield* expectBothCopiesIntact;

            // Developer Mode is now on.
            yield* materializeCodexShadowHome(layout).pipe(onWindowsExpectingNoSymlink);
            yield* expectBothCopiesIntact;

            const stateLinkResult = yield* fileSystem
              .readLink(path.join(shadowHome, "state_5.sqlite"))
              .pipe(Effect.result);
            const configLinkResult = yield* fileSystem
              .readLink(path.join(shadowHome, "config.toml"))
              .pipe(Effect.result);

            expect(stateLinkResult._tag).toBe("Failure");
            expect(configLinkResult._tag).toBe("Failure");
          }),
      );

      it.effect("treats anything at the marker path as the marker", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          // A link to nothing: stat does not see it, an exclusive create still collides with it.
          yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
          yield* Effect.promise(() =>
            NodeFSP.symlink(
              path.join(shadowRoot, "missing"),
              path.join(shadowHome, markerName),
              "junction",
            ),
          );

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout).pipe(onWindowsExpectingNoSymlink);

          const sessionsTarget = yield* fileSystem.readLink(path.join(shadowHome, "sessions"));

          expect(sessionsTarget).toBe(path.join(sharedHome, "sessions"));
        }),
      );

      it.effect("recovers on the next pass when the marker could not be written", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const markerPath = path.join(shadowHome, markerName);

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );
          const unwritableMarker = FileSystem.FileSystem.of({
            ...fileSystem,
            writeFileString: (filePath, data, options) =>
              filePath === markerPath
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "writeFileString",
                      pathOrDescriptor: filePath,
                    }),
                  )
                : fileSystem.writeFileString(filePath, data, options),
          });

          const error = yield* materializeCodexShadowHome(layout).pipe(
            withRefusedSymlinks("win32"),
            Effect.provideService(FileSystem.FileSystem, unwritableMarker),
            Effect.flip,
          );
          yield* materializeCodexShadowHome(layout).pipe(withRefusedSymlinks("win32"));

          const worktreesTarget = yield* fileSystem.readLink(path.join(shadowHome, "worktrees"));
          const markerExists = yield* fileSystem.exists(markerPath);

          expect(error).toMatchObject({
            _tag: "CodexShadowHomeFileSystemError",
            operation: "writeFile",
            path: markerPath,
          });
          expect(worktreesTarget).toBe(path.join(sharedHome, "worktrees"));
          expect(markerExists).toBe(true);
        }),
      );

      it.effect("skips an entry that disappears after the shared home is listed", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const vanishedName = "..codex-global-state.json.bak.tmp-1790718936714-probe";

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );
          const listingVanishedEntry = FileSystem.FileSystem.of({
            ...fileSystem,
            readDirectory: (directoryPath, options) =>
              fileSystem
                .readDirectory(directoryPath, options)
                .pipe(
                  Effect.map((names) =>
                    directoryPath === layout.sharedHomePath ? [...names, vanishedName] : names,
                  ),
                ),
          });

          yield* materializeCodexShadowHome(layout).pipe(
            withRefusedSymlinks("win32"),
            Effect.provideService(FileSystem.FileSystem, listingVanishedEntry),
          );

          const shadowEntries = yield* fileSystem.readDirectory(shadowHome);

          expect(shadowEntries).not.toContain(vanishedName);
        }),
      );

      it.effect("reports a shared entry it cannot inspect", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const sharedConfig = path.join(sharedHome, "config.toml");

          yield* writeTextFile(sharedConfig, 'model = "gpt-5-codex"\n');

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );
          const unreadableConfig = FileSystem.FileSystem.of({
            ...fileSystem,
            stat: (entryPath) =>
              entryPath === sharedConfig
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "stat",
                      pathOrDescriptor: entryPath,
                    }),
                  )
                : fileSystem.stat(entryPath),
          });

          const error = yield* materializeCodexShadowHome(layout).pipe(
            withRefusedSymlinks("win32"),
            Effect.provideService(FileSystem.FileSystem, unreadableConfig),
            Effect.flip,
          );

          expect(error._tag).toBe("CodexShadowHomeFileSystemError");
          expect(error).toMatchObject({ operation: "stat", path: sharedConfig });
        }),
      );

      it.effect("still rejects a real directory where a shared directory belongs", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const shadowRule = path.join(shadowHome, "rules", "local.rules");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout).pipe(withRefusedSymlinks("win32"));
          yield* fileSystem.makeDirectory(path.join(sharedHome, "rules"));
          yield* writeTextFile(shadowRule, "local rule\n");

          const error = yield* materializeCodexShadowHome(layout).pipe(
            withRefusedSymlinks("win32"),
            Effect.flip,
          );
          const shadowRuleExists = yield* fileSystem.exists(shadowRule);

          expect(error).toBeInstanceOf(CodexShadowHomeEntryConflictError);
          expect(error).toMatchObject({ entryName: "rules" });
          expect(shadowRuleExists).toBe(true);
        }),
      );

      it.effect("retargets a stale directory link without touching what it pointed at", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const oldSharedHome = yield* makeTempDir("t3code-codex-old-shared-");
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const oldSessions = path.join(oldSharedHome, "sessions");
          const shadowSessions = path.join(shadowHome, "sessions");

          yield* writeTextFile(path.join(oldSessions, "keep.jsonl"), "{}\n");
          yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
          yield* Effect.promise(() => NodeFSP.symlink(oldSessions, shadowSessions, "junction"));

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout).pipe(withRefusedSymlinks("win32"));

          const sessionsTarget = yield* fileSystem.readLink(shadowSessions);
          const keptContents = yield* fileSystem.readFileString(
            path.join(oldSessions, "keep.jsonl"),
          );

          expect(sessionsTarget).toBe(path.join(sharedHome, "sessions"));
          expect(keptContents).toBe("{}\n");
        }),
      );

      it.effect.skipIf(!symlinksSupported)(
        "keeps earlier file links and falls back for entries that appear later",
        () =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const sharedHome = yield* makeTempDir("t3code-codex-shared-");
            const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
            const shadowHome = path.join(shadowRoot, "shadow");

            yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');

            const layout = yield* resolveCodexHomeLayout(
              decodeCodexSettings({
                homePath: sharedHome,
                shadowHomePath: shadowHome,
              }),
            );

            // Developer Mode is on for the first pass and off from then on.
            yield* materializeCodexShadowHome(layout).pipe(
              Effect.provideService(HostProcessPlatform, "win32"),
            );
            yield* fileSystem.makeDirectory(path.join(sharedHome, "rules"));
            yield* writeTextFile(path.join(sharedHome, "history.jsonl"), "{}\n");
            yield* materializeCodexShadowHome(layout).pipe(withRefusedSymlinks("win32"));

            const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
            const rulesTarget = yield* fileSystem.readLink(path.join(shadowHome, "rules"));
            const shadowEntries = yield* fileSystem.readDirectory(shadowHome);

            expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
            expect(rulesTarget).toBe(path.join(sharedHome, "rules"));
            expect(shadowEntries).toContain(markerName);
            expect(shadowEntries).not.toContain("history.jsonl");
          }),
      );

      it.effect.skipIf(!symlinksSupported)("drops a file link that points into another home", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const oldSharedHome = yield* makeTempDir("t3code-codex-old-shared-");
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const oldConfig = path.join(oldSharedHome, "config.toml");

          yield* writeTextFile(oldConfig, 'model = "old"\n');
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
          yield* fileSystem.symlink(oldConfig, path.join(shadowHome, "config.toml"));

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout).pipe(withRefusedSymlinks("win32"));

          const shadowEntries = yield* fileSystem.readDirectory(shadowHome);
          const oldConfigContents = yield* fileSystem.readFileString(oldConfig);

          expect(shadowEntries).not.toContain("config.toml");
          expect(oldConfigContents).toBe('model = "old"\n');
        }),
      );
    });

    it.effect("does not fall back on other platforms", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
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

        const error = yield* materializeCodexShadowHome(layout).pipe(
          withRefusedSymlinks("linux"),
          Effect.flip,
        );
        const shadowEntries = yield* fileSystem.readDirectory(shadowHome);

        expect(error._tag).toBe("CodexShadowHomeFileSystemError");
        expect(error).toMatchObject({ operation: "symlink" });
        expect(shadowEntries).not.toContain(markerName);
      }),
    );

    it.effect.skipIf(!symlinksSupported)("keeps symlinks on a Windows host that allows them", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");

        yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        yield* materializeCodexShadowHome(layout).pipe(
          Effect.provideService(HostProcessPlatform, "win32"),
        );

        const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
        const sessionsTarget = yield* fileSystem.readLink(path.join(shadowHome, "sessions"));
        const shadowEntries = yield* fileSystem.readDirectory(shadowHome);

        expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
        expect(sessionsTarget).toBe(path.join(sharedHome, "sessions"));
        expect(shadowEntries).not.toContain(markerName);
      }),
    );
  });
});
