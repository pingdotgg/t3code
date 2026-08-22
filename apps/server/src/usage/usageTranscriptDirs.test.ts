import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUsageTranscriptDirs } from "./usageTranscriptDirs.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");

/**
 * Legacy homes are pinned to paths that do not exist so the Claude nested
 * `.claude/projects` probe resolves the same way on every machine.
 */
const makeSettings = (
  root: string,
  providerInstances: Record<string, ProviderInstanceConfig> = {},
): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent, homePath: `${root}/claude` },
    codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, homePath: `${root}/codex` },
  },
  providerInstances: providerInstances as ServerSettings["providerInstances"],
});

it.layer(NodeServices.layer)("usageTranscriptDirs", (it) => {
  describe("resolveUsageTranscriptDirs", () => {
    it.effect("scans the legacy Claude and Codex homes when no instances are configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-usage-dirs-" });

        const dirs = yield* resolveUsageTranscriptDirs(makeSettings(root));

        expect(dirs).toEqual([
          { provider: "codex", dir: path.resolve(root, "codex", "sessions") },
          { provider: "claude", dir: path.resolve(root, "claude", "projects") },
        ]);
      }),
    );

    it.effect("adds a transcript directory for every extra provider instance", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-usage-dirs-" });

        const dirs = yield* resolveUsageTranscriptDirs(
          makeSettings(root, {
            [ProviderInstanceId.make("claude_work")]: {
              driver: CLAUDE,
              config: { homePath: `${root}/claude-work` },
            },
            [ProviderInstanceId.make("codex_personal")]: {
              driver: CODEX,
              config: { homePath: `${root}/codex-personal` },
            },
          }),
        );

        expect(dirs).toEqual([
          { provider: "claude", dir: path.resolve(root, "claude-work", "projects") },
          { provider: "codex", dir: path.resolve(root, "codex-personal", "sessions") },
          { provider: "codex", dir: path.resolve(root, "codex", "sessions") },
          { provider: "claude", dir: path.resolve(root, "claude", "projects") },
        ]);
      }),
    );

    it.effect("prefers a nested .claude/projects directory when the home has one", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-usage-dirs-" });
        const nested = path.join(root, "claude", ".claude", "projects");
        yield* fileSystem.makeDirectory(nested, { recursive: true });

        const dirs = yield* resolveUsageTranscriptDirs(makeSettings(root));

        expect(dirs.find((entry) => entry.provider === "claude")?.dir).toBe(path.resolve(nested));
      }),
    );

    it.effect("collapses instances that share a home so nothing is counted twice", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-usage-dirs-" });

        const dirs = yield* resolveUsageTranscriptDirs(
          makeSettings(root, {
            [ProviderInstanceId.make("claude_chrome")]: {
              driver: CLAUDE,
              config: { homePath: `${root}/claude`, launchArgs: "--chrome" },
            },
          }),
        );

        expect(dirs.filter((entry) => entry.provider === "claude")).toHaveLength(1);
      }),
    );

    it.effect("skips drivers without transcripts and configs that fail to decode", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-usage-dirs-" });

        const dirs = yield* resolveUsageTranscriptDirs(
          makeSettings(root, {
            [ProviderInstanceId.make("cursor_main")]: {
              driver: ProviderDriverKind.make("cursor"),
              config: {},
            },
            [ProviderInstanceId.make("claude_broken")]: {
              driver: CLAUDE,
              config: { homePath: 42 },
            },
          }),
        );

        expect(dirs).toHaveLength(2);
      }),
    );
  });
});
