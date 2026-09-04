import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeCapabilitiesProbeContext,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeConfigDirPath,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* resolveClaudeConfigDirPath({ homePath: "" })).toBe(
          path.join(resolved, ".claude"),
        );
        expect((yield* makeClaudeCapabilitiesProbeContext({ homePath: "" })).cwd).toBe(
          path.resolve(NodeOS.tmpdir()),
        );
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

    it.effect("resolves an environment config directory against the workspace cwd", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const workspaceCwd = path.join(NodeOS.tmpdir(), "t3-claude-workspace");
        const environment = { CLAUDE_CONFIG_DIR: "profile" };

        expect(yield* resolveClaudeConfigDirPath({ homePath: "" }, environment, workspaceCwd)).toBe(
          path.join(workspaceCwd, "profile"),
        );
        const context = yield* makeClaudeCapabilitiesProbeContext(
          { homePath: "" },
          environment,
          workspaceCwd,
        );
        expect(context.cwd).toBe(path.resolve(NodeOS.tmpdir()));
        expect(context.environment.CLAUDE_CONFIG_DIR).toBe(path.join(workspaceCwd, "profile"));
        expect(
          yield* makeClaudeCapabilitiesCacheKey(
            { binaryPath: "claude", homePath: "" },
            environment,
            workspaceCwd,
          ),
        ).toBe(`claude\0${path.join(workspaceCwd, "profile")}`);
      }),
    );

    it.effect("uses inherited HOME or USERPROFILE for the default config directory", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homeEnvironment = { HOME: path.join(NodeOS.tmpdir(), "claude-home-a") };
        const userProfileEnvironment = { USERPROFILE: path.join(NodeOS.tmpdir(), "claude-home-b") };

        expect(yield* resolveClaudeConfigDirPath({ homePath: "" }, homeEnvironment)).toBe(
          path.join(homeEnvironment.HOME, ".claude"),
        );
        expect(yield* resolveClaudeConfigDirPath({ homePath: "" }, userProfileEnvironment)).toBe(
          path.join(userProfileEnvironment.USERPROFILE, ".claude"),
        );
        expect(
          yield* makeClaudeCapabilitiesCacheKey(
            { binaryPath: "claude", homePath: "" },
            homeEnvironment,
          ),
        ).not.toBe(
          yield* makeClaudeCapabilitiesCacheKey(
            { binaryPath: "claude", homePath: "" },
            userProfileEnvironment,
          ),
        );
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
          `claude\0${resolved}`,
        );
      }),
    );

    it.effect("separates capability probes by their resolved configuration directories", () =>
      Effect.gen(function* () {
        const firstConfig = { binaryPath: "claude", homePath: "~/.claude-first" };
        const secondConfig = { binaryPath: "claude", homePath: "~/.claude-second" };
        const first = yield* makeClaudeCapabilitiesCacheKey(firstConfig);
        const second = yield* makeClaudeCapabilitiesCacheKey(secondConfig);
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
