import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
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

    it.effect("applies CLIProxyAPI variables only when the Claude setting is enabled", () =>
      Effect.gen(function* () {
        const baseEnv = {
          PATH: "/bin",
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          ANTHROPIC_AUTH_TOKEN: "ambient-token",
          ANTHROPIC_API_KEY: "ambient-api-key",
        };

        expect(
          yield* makeClaudeEnvironment(
            {
              homePath: "",
              useCliProxyApi: true,
              cliProxyApiUrl: "http://localhost:8317",
              cliProxyApiKey: "proxy-key",
            },
            baseEnv,
          ),
        ).toEqual({
          ...baseEnv,
          ANTHROPIC_BASE_URL: "http://localhost:8317",
          ANTHROPIC_AUTH_TOKEN: "proxy-key",
          ANTHROPIC_API_KEY: "",
        });

        expect(
          yield* makeClaudeEnvironment(
            {
              homePath: "",
              useCliProxyApi: false,
              cliProxyApiUrl: "http://localhost:8317",
              cliProxyApiKey: "proxy-key",
            },
            baseEnv,
          ),
        ).toBe(baseEnv);
      }),
    );

    it.effect("uses the local CLIProxyAPI defaults without forwarding an ambient token", () =>
      Effect.gen(function* () {
        const environment = yield* makeClaudeEnvironment(
          { homePath: "", useCliProxyApi: true, cliProxyApiUrl: "", cliProxyApiKey: "" },
          { PATH: "/bin", ANTHROPIC_AUTH_TOKEN: "ambient-token" },
        );

        expect(environment.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
        expect(environment.ANTHROPIC_AUTH_TOKEN).toBe("");
        expect(environment.ANTHROPIC_API_KEY).toBe("");
      }),
    );
  });
});
