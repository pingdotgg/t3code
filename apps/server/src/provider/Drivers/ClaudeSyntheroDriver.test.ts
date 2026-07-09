import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ClaudeSyntheroSettings } from "@t3tools/contracts";
import {
  makeClaudeSyntheroEnvironment,
  resolveClaudeSyntheroAuthToken,
} from "./ClaudeSyntheroDriver.ts";

const decodeClaudeSyntheroSettings = Schema.decodeSync(ClaudeSyntheroSettings);

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
});
