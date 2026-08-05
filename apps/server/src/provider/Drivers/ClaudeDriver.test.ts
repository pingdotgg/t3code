import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { makeClaudeInstanceEnvironment } from "./ClaudeDriver.ts";

it.layer(NodeServices.layer)("ClaudeDriver environment", (it) => {
  it.effect("refreshes configured homes independently through the driver environment source", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const processPath = process.env.PATH;
      const processClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
      const baseEnv: NodeJS.ProcessEnv = {
        PATH: "before-path",
        TOKEN: "host-before",
        REMOVE_ME: "stale",
        CLAUDE_CONFIG_DIR: "host-home",
      };
      const firstHome = path.resolve("claude-first-home");
      const secondHome = path.resolve("claude-second-home");
      const first = yield* makeClaudeInstanceEnvironment(
        { homePath: firstHome },
        [{ name: "TOKEN", value: "first-instance", sensitive: true }],
        baseEnv,
      );
      const second = yield* makeClaudeInstanceEnvironment(
        { homePath: secondHome },
        [{ name: "TOKEN", value: "second-instance", sensitive: true }],
        baseEnv,
      );
      const firstEnvironment = first.claudeEnvironment;
      const secondEnvironment = second.claudeEnvironment;

      baseEnv.PATH = "after-path";
      baseEnv.TOKEN = "host-after";
      baseEnv.CLAUDE_CONFIG_DIR = "host-after-home";
      delete baseEnv.REMOVE_ME;
      yield* first.refresh;

      expect(first.claudeEnvironment).toBe(firstEnvironment);
      expect(firstEnvironment.PATH).toBe("after-path");
      expect(firstEnvironment.TOKEN).toBe("first-instance");
      expect(firstEnvironment.REMOVE_ME).toBeUndefined();
      expect(firstEnvironment.CLAUDE_CONFIG_DIR).toBe(firstHome);
      expect(second.claudeEnvironment).toBe(secondEnvironment);
      expect(secondEnvironment.PATH).toBe("before-path");
      expect(secondEnvironment.TOKEN).toBe("second-instance");
      expect(secondEnvironment.REMOVE_ME).toBe("stale");
      expect(secondEnvironment.CLAUDE_CONFIG_DIR).toBe(secondHome);
      expect(process.env.PATH).toBe(processPath);
      expect(process.env.CLAUDE_CONFIG_DIR).toBe(processClaudeConfigDir);
    }),
  );
});
