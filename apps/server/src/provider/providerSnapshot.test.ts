import { describe, expect, it } from "vitest";
import type { ModelCapabilities } from "@t3tools/contracts";
import { formatGeminiModelDisplayName } from "@t3tools/shared/gemini";
import { createModelCapabilities } from "@t3tools/shared/model";

import { providerModelsFromSettings } from "./providerSnapshot.ts";

const OPENCODE_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [{ id: "medium", label: "Medium", isDefault: true }],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
      currentValue: "build",
    },
  ],
});

describe("providerModelsFromSettings", () => {
  it("applies the provided capabilities to custom models", () => {
    const models = providerModelsFromSettings(
      [],
      "opencode",
      ["openai/gpt-5"],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "openai/gpt-5",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
    ]);
  });

  it("formats Gemini custom model labels for display", () => {
    const geminiCapabilities: ModelCapabilities = createModelCapabilities({
      optionDescriptors: [],
    });

    const models = providerModelsFromSettings(
      [],
      "gemini",
      ["gemini-3.1-flash-lite-preview"],
      geminiCapabilities,
      { formatCustomModelName: formatGeminiModelDisplayName },
    );

    expect(models).toEqual([
      {
        slug: "gemini-3.1-flash-lite-preview",
        name: "Gemini 3.1 Flash Lite Preview",
        isCustom: true,
        capabilities: geminiCapabilities,
      },
    ]);
  });
});
