import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nextTextGeneratorId, textGeneratorBrand } from "./textGenerators";

describe("nextTextGeneratorId", () => {
  it("skips ids that would make a selection name another target", () => {
    const settings = {
      providerInstances: {
        [ProviderInstanceId.make("openai")]: { driver: ProviderDriverKind.make("codex") },
      },
      textGenerators: {
        [ProviderInstanceId.make("openai-2")]: {
          kind: "openaiCompatible" as const,
          baseUrl: "https://api.openai.com/v1",
          apiKey: "",
          enabled: true,
        },
      },
    };
    const providers = [{ instanceId: ProviderInstanceId.make("openai-3") }];

    expect(nextTextGeneratorId("openai", settings, providers)).toBe("openai-4");
    // A driver's default instance id is taken even before it has a snapshot or config.
    expect(nextTextGeneratorId("cursor", settings, [])).toBe("cursor-2");
    expect(nextTextGeneratorId("openrouter", settings, providers)).toBe("openrouter");
  });
});

describe("textGeneratorBrand", () => {
  it.each([
    ["anthropic", "https://proxy.example/v1", "anthropic"],
    ["opencode", "", "opencode"],
    ["openaiCompatible", "https://openrouter.ai/api/v1", "openrouter"],
    ["openaiCompatible", "https://api.openai.com/v1", "openai"],
    ["openaiCompatible", "http://localhost:11434/v1", "ollama"],
    ["openaiCompatible", "http://localhost:1234/v1", "openaiCompatible"],
  ] as const)("%s at %s shows the %s icon", (kind, baseUrl, brand) => {
    expect(textGeneratorBrand({ kind, baseUrl })).toBe(brand);
  });
});
