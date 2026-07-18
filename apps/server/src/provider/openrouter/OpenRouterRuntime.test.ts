import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { OpenRouterSettings } from "@t3tools/contracts";

import {
  buildOpenRouterProcessEnv,
  normalizeOpenRouterBaseUrl,
  openRouterModelsUrl,
  toClaudeSettings,
} from "./OpenRouterRuntime.ts";

const decodeOpenRouterSettings = Schema.decodeSync(OpenRouterSettings);

describe("OpenRouterRuntime", () => {
  it("normalizes base URL trailing slashes", () => {
    expect(normalizeOpenRouterBaseUrl("https://openrouter.ai/api/")).toBe(
      "https://openrouter.ai/api",
    );
    expect(normalizeOpenRouterBaseUrl("")).toBe("https://openrouter.ai/api");
  });

  it("builds the tools-capable models URL", () => {
    expect(openRouterModelsUrl("https://openrouter.ai/api")).toBe(
      "https://openrouter.ai/api/v1/models?supported_parameters=tools",
    );
  });

  it("maps settings into Claude settings + OpenRouter-owned process env", () => {
    const settings = decodeOpenRouterSettings({
      apiKey: "sk-or-test",
      baseUrl: "https://openrouter.ai/api/",
      binaryPath: "claude",
      httpReferer: "https://t3.chat",
      appTitle: "T3 Code",
    });

    expect(toClaudeSettings(settings)).toMatchObject({
      enabled: true,
      binaryPath: "claude",
      homePath: "",
      launchArgs: "",
    });

    const env = buildOpenRouterProcessEnv(settings, {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "host-anthropic-key",
      ANTHROPIC_AUTH_TOKEN: "host-token",
      OPENROUTER_API_KEY: "host-openrouter",
      OR_SITE_URL: "https://leaked.example",
      OR_APP_NAME: "Leaked",
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    // OpenRouter Claude Code contract: auth token + empty API key.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-or-test");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-test");
    expect(env.HTTP_REFERER).toBe("https://t3.chat");
    expect(env.X_TITLE).toBe("T3 Code");
    expect(env.OR_SITE_URL).toBeUndefined();
    expect(env.OR_APP_NAME).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("clears inherited Anthropic credentials when settings apiKey is empty", () => {
    const settings = decodeOpenRouterSettings({
      apiKey: "",
      httpReferer: "",
      appTitle: "",
    });
    const env = buildOpenRouterProcessEnv(settings, {
      ANTHROPIC_API_KEY: "sk-ant-host",
      ANTHROPIC_AUTH_TOKEN: "host-token",
      OPENROUTER_API_KEY: "sk-or-host",
      HTTP_REFERER: "https://host.example",
      X_TITLE: "Host App",
    });

    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("");
    expect(env.OPENROUTER_API_KEY).toBe("");
    expect(env.HTTP_REFERER).toBeUndefined();
    expect(env.X_TITLE).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
  });
});
