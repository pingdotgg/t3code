import { describe, expect, it } from "vite-plus/test";

import { mapPiModelCatalog, parsePiModelSlug } from "./PiModels.ts";

describe("Pi model catalog mapping", () => {
  it("keeps Pi provider/model identities distinct and groups them by provider", () => {
    const models = mapPiModelCatalog([
      {
        model: {
          provider: "custom-gateway",
          id: "team/coder",
          name: "Team Coder",
        },
        thinkingLevels: ["off", "high", "max"],
        currentThinkingLevel: "high",
      },
      {
        model: {
          provider: "openai",
          id: "gpt-plain",
          name: "GPT Plain",
        },
        thinkingLevels: ["off"],
        currentThinkingLevel: "off",
      },
    ]);

    expect(models).toEqual([
      {
        slug: "custom-gateway/team%2Fcoder",
        name: "Team Coder",
        shortName: "team/coder",
        subProvider: "custom-gateway",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Thinking",
              type: "select",
              currentValue: "high",
              options: [
                { id: "off", label: "Off" },
                { id: "high", label: "High", isDefault: true },
                { id: "max", label: "Max" },
              ],
            },
          ],
        },
      },
      {
        slug: "openai/gpt-plain",
        name: "GPT Plain",
        shortName: "gpt-plain",
        subProvider: "openai",
        isCustom: false,
        capabilities: {
          optionDescriptors: [],
        },
      },
    ]);
  });

  it("round-trips a picker model slug back to Pi's provider/model selection", () => {
    expect(parsePiModelSlug("custom-gateway/team%2Fcoder")).toEqual({
      provider: "custom-gateway",
      modelId: "team/coder",
    });
    expect(parsePiModelSlug("not-a-pi-model")).toBeUndefined();
    expect(parsePiModelSlug("custom-gateway/%E0%A4%A")).toBeUndefined();
  });
});
