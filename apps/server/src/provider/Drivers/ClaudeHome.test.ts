import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  claudeLocalSettingsDirectory,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  it.effect("finds the main checkout from a worktree whose name holds a line separator", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-local-" });
      const worktree = path.join(repo, ".claude", "worktrees", "feature\u2028tools");
      const worktreeGitDir = path.join(repo, ".git", "worktrees", "feature\u2028tools");
      yield* fileSystem.makeDirectory(worktree, { recursive: true });
      yield* fileSystem.makeDirectory(worktreeGitDir, { recursive: true });
      yield* fileSystem.writeFileString(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
      yield* fileSystem.writeFileString(path.join(worktreeGitDir, "commondir"), "../..\n");

      expect(yield* claudeLocalSettingsDirectory(worktree)).toBe(repo);
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  describe("Claude home resolution", () => {
    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it.effect("gives a symlinked Claude home the continuation key of its target", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
        const target = path.join(root, ".claude");
        const link = path.join(root, ".claude-second-account");
        yield* fileSystem.makeDirectory(target);
        yield* fileSystem.symlink(target, link);

        const direct = yield* makeClaudeContinuationGroupKey({ homePath: target });
        expect(yield* makeClaudeContinuationGroupKey({ homePath: link })).toBe(direct);
        expect(
          yield* makeClaudeContinuationGroupKey({ homePath: "" }, { CLAUDE_CONFIG_DIR: link }),
        ).toBe(direct);
        // The spawned process keeps the literal path, because Claude keys its login by that path.
        expect((yield* makeClaudeEnvironment({ homePath: link })).CLAUDE_CONFIG_DIR).toBe(link);
      }).pipe(Effect.scoped),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });

  it.effect(
    "drops the launching Claude session and Electron's run-as-Node flag, and labels processes t3-code unless overridden, without reading settings while turned off",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
        const host = {
          CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "host-session",
          CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/host-claude.sock",
          CLAUDE_EFFORT: "high",
          ELECTRON_RUN_AS_NODE: "1",
          KEEP: "1",
        };
        const instance = [
          { name: "CLAUDE_CODE_ENTRYPOINT", value: "instance", sensitive: false },
          { name: "CLAUDE_EFFORT", value: "low", sensitive: false },
        ];

        expect(
          yield* mergeClaudeProcessEnvironment({ homePath, enabled: true }, undefined, host),
        ).toEqual({
          CLAUDE_CODE_ENTRYPOINT: "t3-code",
          KEEP: "1",
        });
        expect(
          yield* mergeClaudeProcessEnvironment({ homePath, enabled: true }, instance, host),
        ).toEqual({
          CLAUDE_CODE_ENTRYPOINT: "instance",
          CLAUDE_EFFORT: "low",
          KEEP: "1",
        });

        yield* fileSystem.writeFileString(
          path.join(homePath, "settings.json"),
          JSON.stringify({ env: { CLAUDE_CODE_ENTRYPOINT: "custom" } }),
        );
        expect(
          (yield* mergeClaudeProcessEnvironment({ homePath, enabled: true }, instance, host))
            .CLAUDE_CODE_ENTRYPOINT,
        ).toBe("custom");
        expect(
          (yield* mergeClaudeProcessEnvironment({ homePath, enabled: false }, instance, host))
            .CLAUDE_CODE_ENTRYPOINT,
        ).toBe("instance");
      }),
  );
});
