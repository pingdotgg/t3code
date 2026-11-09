import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nextTextGeneratorId } from "./textGenerators";

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
