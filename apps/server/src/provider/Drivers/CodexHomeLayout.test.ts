import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import {
  CodexShadowHomeEntryConflictError,
  CodexShadowHomePathConflictError,
  materializeCodexHomeLayout,
  resolveCodexHomeLayout,
  resolveCodexProviderHomeLayout,
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
    it.effect("isolates and restores the provider's home without migrating state", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* makeTempDir("t3-codex-home-");
        const instanceId = ProviderInstanceId.make("codex");
        const sharedHome = path.join(stateDir, "shared");
        const shadowHome = path.join(stateDir, "shadow");
        const previousConfig = decodeCodexSettings({
          homePath: sharedHome,
          shadowHomePath: shadowHome,
        });
        yield* writeTextFile(path.join(sharedHome, "sessions", "previous.jsonl"), "previous");

        const previous = yield* resolveCodexProviderHomeLayout(
          previousConfig,
          stateDir,
          instanceId,
        );
        expect(previous.effectiveHomePath).toBe(shadowHome);

        const enabled = { ...previousConfig, dedicatedHome: true };
        const dedicated = yield* resolveCodexProviderHomeLayout(enabled, stateDir, instanceId);
        const homePath = path.join(stateDir, "providers", "codex", instanceId, "home");
        expect(dedicated).toMatchObject({
          mode: "dedicated",
          sharedHomePath: homePath,
          effectiveHomePath: homePath,
          continuationKey: `codex:home:${homePath}`,
        });
        yield* materializeCodexHomeLayout(dedicated);
        expect(yield* fs.readDirectory(homePath)).toEqual([]);
        expect(yield* fs.exists(shadowHome)).toBe(false);
        expect(yield* fs.readFileString(path.join(sharedHome, "sessions", "previous.jsonl"))).toBe(
          "previous",
        );
        const another = yield* resolveCodexProviderHomeLayout(
          enabled,
          stateDir,
          ProviderInstanceId.make("another"),
        );
        expect(another.continuationKey).not.toBe(dedicated.continuationKey);
        expect(
          yield* resolveCodexProviderHomeLayout(
            { ...enabled, dedicatedHome: false },
            stateDir,
            instanceId,
          ),
        ).toEqual(previous);
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

  describe("materializeCodexHomeLayout", () => {
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

          yield* materializeCodexHomeLayout(layout);
          expect(yield* fileSystem.readFileString(shadowMetadata)).toBe("shadow Finder metadata");
          yield* fileSystem.remove(shadowMetadata);
          yield* materializeCodexHomeLayout(layout);
          expect(yield* fileSystem.exists(shadowMetadata)).toBe(false);

          yield* writeTextFile(shadowMetadata, "shadow Finder metadata");
          yield* materializeCodexHomeLayout(layout);
          yield* materializeCodexHomeLayout(layout);

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

          yield* materializeCodexHomeLayout(layout);

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

          yield* materializeCodexHomeLayout(layout);

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

          yield* materializeCodexHomeLayout(layout);

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

          yield* materializeCodexHomeLayout(layout);
          expect(yield* fileSystem.exists(threadLock)).toBe(true);

          yield* fileSystem.remove(threadLock);
          yield* materializeCodexHomeLayout(layout);
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

          yield* materializeCodexHomeLayout(layout);

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

        const error = yield* materializeCodexHomeLayout(layout).pipe(Effect.flip);

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

          const error = yield* materializeCodexHomeLayout(layout).pipe(Effect.flip);

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
