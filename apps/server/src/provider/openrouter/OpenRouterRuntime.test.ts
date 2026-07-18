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

  it("maps settings into Claude settings + process env owned by the driver", () => {
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

    const env = buildOpenRouterProcessEnv(settings, { PATH: "/usr/bin" });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-or-test");
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-test");
    expect(env.HTTP_REFERER).toBe("https://t3.chat");
    expect(env.X_TITLE).toBe("T3 Code");
    expect(env.PATH).toBe("/usr/bin");
  });
});
