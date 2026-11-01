import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";

import {
  writeClaudeProxySettingsFile,
  applyClaudeProxyEnvironment,
  applyClaudeProxySettings,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

describe("applyClaudeProxyEnvironment", () => {
  it("replaces every ambient route with the proxy", () => {
    expect(
      applyClaudeProxyEnvironment(
        {
          PATH: "/bin",
          ANTHROPIC_API_KEY: "sk-ant-direct",
          ANTHROPIC_BASE_URL: "https://api.anthropic.com",
          CLAUDE_CODE_OAUTH_TOKEN: "oauth",
          CLAUDE_CODE_USE_BEDROCK: "1",
        },
        { url: "http://proxy:8317", apiKey: "sk-proxy" },
      ),
    ).toEqual({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: "http://proxy:8317",
      ANTHROPIC_AUTH_TOKEN: "sk-proxy",
    });
    const settings = {
      env: { KEEP: "yes", ANTHROPIC_BASE_URL: "https://direct.example" },
      disableAllHooks: true,
    };
    expect(applyClaudeProxySettings(settings, undefined)).toBe(settings);
    expect(
      applyClaudeProxySettings(settings, { url: "http://proxy:8317", apiKey: "" }),
    ).toMatchObject({
      disableAllHooks: true,
      env: {
        KEEP: "yes",
        ANTHROPIC_BASE_URL: "http://proxy:8317",
        ANTHROPIC_AUTH_TOKEN: "t3-proxy",
        CLAUDE_CODE_USE_GATEWAY: "0",
      },
    });
    // Claude Code reports "Not logged in" without contacting a proxy when no credential is set.
    expect(
      applyClaudeProxyEnvironment({}, { url: "http://proxy:8317", apiKey: "" })
        .ANTHROPIC_AUTH_TOKEN,
    ).toBe("t3-proxy");
  });
});

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped();
        const proxySettings = applyClaudeProxySettings(
          {},
          { url: "http://proxy:8317", apiKey: "test" },
        );
        yield* fileSystem.writeFileString(
          path.join(directory, "remote-settings.json"),
          '{"env":{"ANTHROPIC_BASE_URL":"https://managed.example"}}',
        );
        const conflict = yield* Effect.flip(
          writeClaudeProxySettingsFile(proxySettings, { CLAUDE_CONFIG_DIR: directory }),
        );
        expect(conflict).toMatchObject({
          _tag: "ClaudeProxySettingsError",
          message: expect.stringContaining("managed policy conflicts"),
        });
        yield* fileSystem.writeFileString(
          path.join(directory, "remote-settings.json"),
          '{"disableAllHooks":true,"env":{"ANTHROPIC_MODEL":"claude-haiku-5-5"}}',
        );
        const settingsPath = yield* writeClaudeProxySettingsFile(proxySettings, {
          CLAUDE_CONFIG_DIR: directory,
        });
        expect(yield* fileSystem.readFileString(settingsPath)).toContain("http://proxy:8317");
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }).pipe(Effect.scoped),
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
});
