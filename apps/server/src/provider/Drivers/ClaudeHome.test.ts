import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  makeClaudeEnvironmentSource,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";
import { makeProviderInstanceEnvironmentSource } from "../ProviderInstanceEnvironment.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

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

    it.effect("refreshes an isolated Claude environment in place", () =>
      Effect.gen(function* () {
        const baseEnv: NodeJS.ProcessEnv = {
          PATH: "before-path",
          API_KEY: "host-before",
          REMOVE_ME: "stale",
          CLAUDE_CONFIG_DIR: "host-claude-home",
        };
        const instanceEnvironment = makeProviderInstanceEnvironmentSource(
          [{ name: "API_KEY", value: "instance-key", sensitive: true }],
          baseEnv,
        );
        const claudeEnvironment = yield* makeClaudeEnvironmentSource(
          { homePath: "~/.claude-work" },
          instanceEnvironment.environment,
        );
        const captured = claudeEnvironment.environment;
        const processPath = process.env.PATH;
        const processClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

        expect(captured.PATH).toBe("before-path");
        expect(captured.API_KEY).toBe("instance-key");
        expect(captured.CLAUDE_CONFIG_DIR).not.toBe("host-claude-home");

        baseEnv.PATH = "after-path";
        baseEnv.API_KEY = "host-after";
        baseEnv.CLAUDE_CONFIG_DIR = "host-after-claude-home";
        delete baseEnv.REMOVE_ME;
        yield* instanceEnvironment.refresh;
        yield* claudeEnvironment.refresh;

        expect(claudeEnvironment.environment).toBe(captured);
        expect(captured.PATH).toBe("after-path");
        expect(captured.API_KEY).toBe("instance-key");
        expect(captured.REMOVE_ME).toBeUndefined();
        expect(captured.CLAUDE_CONFIG_DIR).not.toBe("host-after-claude-home");
        expect(process.env.PATH).toBe(processPath);
        expect(process.env.CLAUDE_CONFIG_DIR).toBe(processClaudeConfigDir);
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

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
          `claude:home:${resolved}`,
        );
      }),
    );
  });
});
