import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  mergeClaudeBaseEnvironment,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
  resolveClaudeSessionEnvironment,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
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
    "drops the launching Claude session and labels subscription processes t3-code unless overridden",
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
          KEEP: "1",
        };
        const instance = [
          { name: "CLAUDE_CODE_ENTRYPOINT", value: "instance", sensitive: false },
          { name: "CLAUDE_EFFORT", value: "low", sensitive: false },
        ];

        expect(yield* mergeClaudeProcessEnvironment({ homePath }, undefined, host)).toEqual({
          CLAUDE_CODE_ENTRYPOINT: "t3-code",
          KEEP: "1",
        });
        expect(yield* mergeClaudeProcessEnvironment({ homePath }, instance, host)).toEqual({
          CLAUDE_CODE_ENTRYPOINT: "instance",
          CLAUDE_EFFORT: "low",
          KEEP: "1",
        });

        const apiKey = { name: "ANTHROPIC_API_KEY", value: "key", sensitive: true };
        expect(yield* mergeClaudeProcessEnvironment({ homePath }, [apiKey], host)).toEqual({
          ANTHROPIC_API_KEY: "key",
          KEEP: "1",
        });
        expect(
          (yield* mergeClaudeProcessEnvironment({ homePath }, undefined, {
            ...host,
            ANTHROPIC_API_KEY: "key",
          })).CLAUDE_CODE_ENTRYPOINT,
        ).toBeUndefined();
        expect(
          (yield* mergeClaudeProcessEnvironment({ homePath }, [apiKey, ...instance], host))
            .CLAUDE_CODE_ENTRYPOINT,
        ).toBe("instance");

        yield* fileSystem.writeFileString(
          path.join(homePath, "settings.json"),
          JSON.stringify({ env: { ANTHROPIC_API_KEY: "key" } }),
        );
        expect(
          (yield* mergeClaudeProcessEnvironment({ homePath }, undefined, host))
            .CLAUDE_CODE_ENTRYPOINT,
        ).toBeUndefined();

        yield* fileSystem.writeFileString(
          path.join(homePath, "settings.json"),
          JSON.stringify({ env: { ANTHROPIC_API_KEY: "" } }),
        );
        expect(
          (yield* mergeClaudeProcessEnvironment({ homePath }, [apiKey], host))
            .CLAUDE_CODE_ENTRYPOINT,
        ).toBe("t3-code");

        yield* fileSystem.writeFileString(
          path.join(homePath, "settings.json"),
          JSON.stringify({ env: { CLAUDE_CODE_ENTRYPOINT: "custom" } }),
        );
        expect(
          (yield* mergeClaudeProcessEnvironment({ homePath }, instance, host))
            .CLAUDE_CODE_ENTRYPOINT,
        ).toBe("custom");
      }),
  );

  it.effect("labels each session from its effective Claude settings", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-repo-" });
      const worktree = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-wt-" });
      const worktreeGitDir = path.join(workspace, ".git", "worktrees", "wt");
      yield* fileSystem.makeDirectory(worktreeGitDir, { recursive: true });
      yield* fileSystem.writeFileString(path.join(worktreeGitDir, "commondir"), "../..\n");
      yield* fileSystem.writeFileString(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
      yield* fileSystem.makeDirectory(path.join(workspace, ".claude"));
      const project = path.join(workspace, ".claude", "settings.json");
      const local = path.join(workspace, ".claude", "settings.local.json");
      const user = path.join(homePath, "settings.json");
      const write = (file: string, env: Record<string, string>) =>
        fileSystem.writeFileString(file, JSON.stringify({ env }));
      const entrypoint = (
        environment: NodeJS.ProcessEnv,
        launchArgEnv?: Readonly<Record<string, unknown>>,
        cwd = workspace,
      ) =>
        resolveClaudeSessionEnvironment({ homePath }, environment, cwd, launchArgEnv).pipe(
          Effect.map((resolved) => resolved.CLAUDE_CODE_ENTRYPOINT),
        );
      const subscription = {};
      const apiKey = { ANTHROPIC_API_KEY: "key" };

      expect(yield* entrypoint(subscription)).toBe("t3-code");
      // Windows names ignore case, and a copy of process.env loses that.
      const windowsBase = yield* mergeClaudeBaseEnvironment(undefined, {
        Anthropic_Api_Key: "key",
        Claude_Code_Entrypoint: "claude-desktop",
      }).pipe(Effect.provideService(HostProcess.Platform, "win32"));
      expect(windowsBase).toEqual({ ANTHROPIC_API_KEY: "key" });

      // Every settings layer can bring the key, including a file edited after the server started.
      yield* write(user, apiKey);
      expect(yield* entrypoint(subscription)).toBeUndefined();
      yield* write(user, {});
      yield* write(project, apiKey);
      expect(yield* entrypoint(subscription)).toBeUndefined();
      yield* write(project, {});
      yield* write(local, apiKey);
      expect(yield* entrypoint(subscription)).toBeUndefined();
      // A worktree uses the local file in its main checkout.
      expect(yield* entrypoint(subscription, undefined, worktree)).toBeUndefined();
      yield* write(local, {});
      expect(yield* entrypoint(subscription, apiKey)).toBeUndefined();

      // A higher layer that empties the key wins: --settings over local over project over user.
      yield* write(user, apiKey);
      yield* write(project, { ANTHROPIC_API_KEY: "" });
      expect(yield* entrypoint({})).toBe("t3-code");
      yield* write(local, apiKey);
      expect(yield* entrypoint(subscription)).toBeUndefined();
      expect(yield* entrypoint(subscription, { ANTHROPIC_API_KEY: "" })).toBe("t3-code");
      yield* write(user, {});
      yield* write(project, {});
      yield* write(local, { ANTHROPIC_API_KEY: "" });
      expect(yield* entrypoint(apiKey)).toBe("t3-code");
      yield* write(local, {});

      // The base env keeps only a label the instance configured, so settings edits take effect.
      yield* write(user, { CLAUDE_CODE_ENTRYPOINT: "removed-later" });
      const base = yield* mergeClaudeBaseEnvironment(undefined, {
        CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
        CLAUDECODE: "1",
      });
      expect(base).toEqual({});
      expect(yield* entrypoint(base)).toBe("removed-later");
      yield* write(user, {});
      expect(yield* entrypoint(base)).toBe("t3-code");

      // Even t3-code is kept when the instance configures it.
      expect(yield* entrypoint({ ...apiKey, CLAUDE_CODE_ENTRYPOINT: "t3-code" })).toBe("t3-code");

      // A configured label survives a session key, and session settings can set one themselves.
      expect(yield* entrypoint({ ...apiKey, CLAUDE_CODE_ENTRYPOINT: "instance" })).toBe("instance");
      yield* write(project, { CLAUDE_CODE_ENTRYPOINT: "project" });
      expect(yield* entrypoint(apiKey)).toBe("project");
      expect(yield* entrypoint(apiKey, { CLAUDE_CODE_ENTRYPOINT: "launch" })).toBe("launch");

      // A wrongly typed value in one file does not hide the other values in that file.
      yield* fileSystem.writeFileString(
        project,
        JSON.stringify({ env: { CLAUDE_CODE_ENTRYPOINT: 1, ANTHROPIC_API_KEY: "key" } }),
      );
      expect(yield* entrypoint(subscription)).toBeUndefined();

      // Claude Code skips a settings file that is not strict JSON, so its key does not count.
      for (const invalid of [
        '// note\n{"env":{"ANTHROPIC_API_KEY":"key"}}',
        '{"env":{"ANTHROPIC_API_KEY":"key",},}',
      ]) {
        yield* fileSystem.writeFileString(project, invalid);
        expect(yield* entrypoint(subscription)).toBe("t3-code");
      }
    }),
  );
});
