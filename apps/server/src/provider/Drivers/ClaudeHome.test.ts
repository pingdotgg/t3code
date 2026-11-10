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
  mergeClaudeProcessEnvironment,
  resolveClaudeAccountConfigPath,
  resolveClaudeHomePath,
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

    it.effect("leaves CLAUDE_CONFIG_DIR unset when homePath is the default Claude home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const baseEnv = { CLAUDE_CONFIG_DIR: "/tmp/claude-inherited", KEEP: "1" };

        for (const homePath of ["~/.claude", `${path.join(NodeOS.homedir(), ".claude")}/`]) {
          expect(yield* makeClaudeEnvironment({ homePath }, baseEnv)).toEqual({ KEEP: "1" });
        }
        // Windows env names are case-insensitive, so any spelling selects the config dir there.
        const windowsEnv = yield* makeClaudeEnvironment(
          { homePath: "~/.claude" },
          { Claude_Config_Dir: "/tmp/claude-inherited", KEEP: "1" },
        ).pipe(Effect.provideService(HostProcess.Platform, "win32"));
        expect(windowsEnv).toEqual({ KEEP: "1" });
      }),
    );

    it.effect("compares against the child's home, not the server's", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* makeClaudeEnvironment(
          { homePath: "~/.claude" },
          { HOME: "/accounts/shell" },
        );
        expect(environment.CLAUDE_CONFIG_DIR).toBe(path.resolve(NodeOS.homedir(), ".claude"));
        // Windows resolves Claude's default home from USERPROFILE, not HOME.
        const windowsEnv = yield* makeClaudeEnvironment(
          { homePath: "~/.claude" },
          { UserProfile: "/accounts/windows" },
        ).pipe(Effect.provideService(HostProcess.Platform, "win32"));
        expect(windowsEnv.CLAUDE_CONFIG_DIR).toBe(path.resolve(NodeOS.homedir(), ".claude"));
        expect(
          yield* resolveClaudeAccountConfigPath(
            { homePath: "/accounts/shell/.claude" },
            { HOME: "/accounts/shell" },
          ),
        ).toBe("/accounts/shell/.claude.json");
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
    "drops the launching Claude session and labels processes t3-code unless overridden",
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
});
