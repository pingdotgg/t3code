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
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect((yield* makeClaudeCapabilitiesProbeContext({ homePath: "" })).cwd).toBe(
          path.resolve(NodeOS.tmpdir()),
        );
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        const probeContext = yield* makeClaudeCapabilitiesProbeContext({ homePath });
        expect(probeContext.cwd).toBe(path.resolve(NodeOS.tmpdir()));
        expect(probeContext.environment.CLAUDE_CONFIG_DIR).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}`,
        );
      }),
    );

    it.effect("keeps a relative inherited config dir stable when the probe cwd changes", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const workspaceCwd = path.join(NodeOS.tmpdir(), "claude-workspace");
        const resolvedConfigDir = path.resolve(workspaceCwd, "relative-config");
        const environment = { CLAUDE_CONFIG_DIR: "relative-config" };

        const probeContext = yield* makeClaudeCapabilitiesProbeContext(
          { homePath: "" },
          environment,
          workspaceCwd,
        );

        expect(probeContext.cwd).toBe(path.resolve(NodeOS.tmpdir()));
        expect(probeContext.environment.CLAUDE_CONFIG_DIR).toBe(resolvedConfigDir);
        expect(
          yield* makeClaudeCapabilitiesCacheKey(
            { binaryPath: "claude", homePath: "" },
            environment,
            workspaceCwd,
          ),
        ).toBe(`claude\0${resolvedConfigDir}`);
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
