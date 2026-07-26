import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ClaudeSyntheroSettings, ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import {
  makeClaudeSyntheroEnvironment,
  resolveCurrentClaudeSyntheroSettings,
  resolveClaudeSyntheroAuthToken,
} from "./ClaudeSyntheroDriver.ts";

const decodeClaudeSyntheroSettings = Schema.decodeSync(ClaudeSyntheroSettings);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

describe("ClaudeSyntheroDriver", () => {
  it("defaults to an isolated Claude HOME and Synthero base URL", () => {
    const settings = decodeClaudeSyntheroSettings({});

    expect(settings.enabled).toBe(true);
    expect(settings.binaryPath).toBe("claude");
    expect(settings.homePath).toBe("~/.claude-synthero");
    expect(settings.baseURL).toBe("https://api.synterolink.com");
    expect(settings.authToken).toBe("");
  });

  it("builds a Claude Code environment without touching normal Claude auth", () => {
    const settings = decodeClaudeSyntheroSettings({ authToken: "sk-configured" });
    const env = makeClaudeSyntheroEnvironment({
      settings,
      providerEnvironment: [],
      baseEnv: {
        HOME: "/Users/example",
        ANTHROPIC_AUTH_TOKEN: "sk-normal-claude",
      },
    });

    expect(env.HOME).toBe("/Users/example");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.synterolink.com");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-configured");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0");
  });

  it("does not inherit a normal Claude auth token when Synthero auth is missing", () => {
    const settings = decodeClaudeSyntheroSettings({});
    const env = makeClaudeSyntheroEnvironment({
      settings,
      providerEnvironment: [],
      baseEnv: { ANTHROPIC_AUTH_TOKEN: "sk-normal-claude" },
    });

    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.synterolink.com");
  });

  it("prefers configured auth token then provider-scoped env fallback", () => {
    const configured = decodeClaudeSyntheroSettings({ authToken: "sk-configured" });
    const fallback = decodeClaudeSyntheroSettings({});

    expect(resolveClaudeSyntheroAuthToken(configured, [], {})).toBe("sk-configured");
    expect(
      resolveClaudeSyntheroAuthToken(
        fallback,
        [{ name: "SYNTHERO_AUTH_TOKEN", value: "sk-provider", sensitive: true }],
        { SYNTHERO_AUTH_TOKEN: "sk-process" },
      ),
    ).toBe("sk-provider");
  });

  effectIt.effect("resolves current provider-instance settings for status refreshes", () =>
    Effect.gen(function* () {
      const fallbackConfig = decodeClaudeSyntheroSettings({ authToken: "sk-old" });
      const settings = decodeServerSettings({
        providerInstances: {
          "claude-synthero": {
            driver: "claude-synthero",
            enabled: true,
            config: {
              authToken: "sk-updated",
              baseURL: "https://api.syntherolink.com/updated",
            },
          },
        },
      });

      const resolved = yield* resolveCurrentClaudeSyntheroSettings({
        settings,
        instanceId: ProviderInstanceId.make("claude-synthero"),
        fallbackConfig,
      });

      expect(resolved.authToken).toBe("sk-updated");
      expect(resolved.baseURL).toBe("https://api.syntherolink.com/updated");
      expect(resolved.enabled).toBe(true);
    }),
  );

  effectIt.effect(
    "falls back to the legacy provider settings when no provider instance overrides it",
    () =>
      Effect.gen(function* () {
        const fallbackConfig = decodeClaudeSyntheroSettings({ authToken: "sk-old" });
        const settings = decodeServerSettings({
          providers: {
            "claude-synthero": {
              authToken: "sk-legacy",
            },
          },
        });

        const resolved = yield* resolveCurrentClaudeSyntheroSettings({
          settings,
          instanceId: ProviderInstanceId.make("claude-synthero"),
          fallbackConfig,
        });

        expect(resolved.authToken).toBe("sk-legacy");
      }),
  );
});
