import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { CodexSettings } from "@t3tools/contracts";
import {
  CodexShadowHomeEntryConflictError,
  CodexShadowHomePathConflictError,
  CodexShadowHomePrivateEntrySymlinkError,
  classifyCodexShadowHomeEntry,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
const decodeCodexSettingsValue = Schema.decodeSync(CodexSettings);

const AUTH_LIKE_ENTRY_NAMES = [
  "auth.json",
  "auth-fixture-a.json",
  "auth-fixture-b.json",
  "auth-fixture-c.json",
  "auth.json.bak",
  "auth_fixture_d.json",
] as const;

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
  describe("classifyCodexShadowHomeEntry", () => {
    it("fails closed for auth-like names without matching normal shared names", () => {
      for (const entryName of AUTH_LIKE_ENTRY_NAMES) {
        expect(classifyCodexShadowHomeEntry(entryName)).toBe("credential-private");
      }
      expect(classifyCodexShadowHomeEntry("AUTH-FIXTURE-E.JSON")).toBe("credential-private");
      expect(classifyCodexShadowHomeEntry("author.json")).toBe("shared");
      expect(classifyCodexShadowHomeEntry("sessions")).toBe("shared");
      expect(classifyCodexShadowHomeEntry("config.toml")).toBe("shared");
      expect(classifyCodexShadowHomeEntry("skills")).toBe("shared");
      expect(classifyCodexShadowHomeEntry("cache")).toBe("shared");
      expect(classifyCodexShadowHomeEntry("models_cache.json")).toBe("private");
      expect(classifyCodexShadowHomeEntry("memories")).toBe("shadow-local");
    });
  });

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
    it.effect("keeps auth-like files private while sharing normal Codex state", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");

        yield* fileSystem.makeDirectory(path.join(sharedHome, "sessions"));
        yield* writeTextFile(path.join(sharedHome, "skills", "fixture", "SKILL.md"), "fixture\n");
        yield* writeTextFile(path.join(sharedHome, "cache", "fixture.json"), "{}\n");
        yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
        yield* writeTextFile(path.join(sharedHome, "models_cache.json"), '{"models":["shared"]}\n');
        yield* writeTextFile(path.join(sharedHome, "author.json"), '{"kind":"fixture"}\n');
        yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
        for (const entryName of AUTH_LIKE_ENTRY_NAMES) {
          yield* writeTextFile(path.join(sharedHome, entryName), '{"scope":"shared-fixture"}\n');
          yield* writeTextFile(path.join(shadowHome, entryName), '{"scope":"shadow-fixture"}\n');
        }
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
        const skillsTarget = yield* fileSystem.readLink(path.join(shadowHome, "skills"));
        const cacheTarget = yield* fileSystem.readLink(path.join(shadowHome, "cache"));
        const authorTarget = yield* fileSystem.readLink(path.join(shadowHome, "author.json"));
        const mcpOauthLocksTarget = yield* fileSystem.readLink(
          path.join(shadowHome, "mcp-oauth-locks"),
        );
        const modelsCacheExists = yield* fileSystem.exists(
          path.join(shadowHome, "models_cache.json"),
        );

        expect(sessionsTarget).toBe(path.join(sharedHome, "sessions"));
        expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
        expect(skillsTarget).toBe(path.join(sharedHome, "skills"));
        expect(cacheTarget).toBe(path.join(sharedHome, "cache"));
        expect(authorTarget).toBe(path.join(sharedHome, "author.json"));
        expect(mcpOauthLocksTarget).toBe(path.join(sharedHome, "mcp-oauth-locks"));
        expect(modelsCacheExists).toBe(false);
        for (const entryName of AUTH_LIKE_ENTRY_NAMES) {
          const authLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, entryName))
            .pipe(Effect.result);
          const authContents = yield* fileSystem.readFileString(path.join(shadowHome, entryName));
          expect(authLinkResult._tag).toBe("Failure");
          expect(authContents).toContain("shadow-fixture");
        }
      }),
    );

    it.effect("rejects an auth-like entry that is already a shadow-home symlink", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");
        const entryName = "auth-fixture-a.json";
        const sharedAuthPath = path.join(sharedHome, entryName);
        const shadowAuthPath = path.join(shadowHome, entryName);

        yield* writeTextFile(sharedAuthPath, '{"scope":"shared-fixture"}\n');
        yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
        yield* fileSystem.symlink(sharedAuthPath, shadowAuthPath);

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

        expect(error).toBeInstanceOf(CodexShadowHomePrivateEntrySymlinkError);
        expect(error).toMatchObject({
          sharedHomePath: sharedHome,
          effectiveHomePath: shadowHome,
          entryName,
          path: shadowAuthPath,
        });
      }),
    );

    it.effect("replaces Codex-created local MCP OAuth locks with the shared lock directory", () =>
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

    it.effect("accepts Codex-created shadow-local runtime directories", () =>
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

    it.effect("rejects shared entries that already exist in the shadow home as real files", () =>
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
  });
});
