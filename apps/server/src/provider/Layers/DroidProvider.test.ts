import { ModelProvider, ReasoningEffort, type AvailableModelConfig } from "@factory/droid-sdk";
import { describe, expect, it } from "vitest";

import { buildDroidModelsFromSdkModels } from "./DroidProvider.ts";

const sdkModel = (model: AvailableModelConfig): AvailableModelConfig => model;

describe("DroidProvider", () => {
  it("maps Droid SDK built-in and custom models into provider models", () => {
    const models = buildDroidModelsFromSdkModels([
      sdkModel({
        id: "glm-5.1",
        modelId: "glm-5.1",
        displayName: "Droid Core (GLM-5.1)",
        shortDisplayName: "GLM-5.1",
        modelProvider: ModelProvider.FACTORY,
        supportedReasoningEfforts: [ReasoningEffort.Off, ReasoningEffort.High],
        defaultReasoningEffort: ReasoningEffort.High,
        isCustom: false,
      }),
      sdkModel({
        id: "custom:HomeLab-GLM-5.1-26",
        modelId: "glm-5.1",
        displayName: "HomeLab - GLM-5.1",
        shortDisplayName: "HomeLab GLM",
        modelProvider: ModelProvider.GENERIC_CHAT_COMPLETION_API,
        supportedReasoningEfforts: [ReasoningEffort.None],
        defaultReasoningEffort: ReasoningEffort.None,
        isCustom: true,
      }),
      sdkModel({
        id: "custom:Proxy-GLM-5.1-27",
        modelId: "glm-5.1",
        displayName: "Proxy - GLM-5.1",
        shortDisplayName: "Proxy GLM",
        modelProvider: ModelProvider.GENERIC_CHAT_COMPLETION_API,
        supportedReasoningEfforts: [ReasoningEffort.None],
        defaultReasoningEffort: ReasoningEffort.None,
        isCustom: true,
      }),
    ]);

    expect(models.map((model) => [model.slug, model.name, model.isCustom])).toEqual([
      ["glm-5.1", "Droid Core (GLM-5.1)", false],
      ["custom:HomeLab-GLM-5.1-26", "HomeLab - GLM-5.1", true],
      ["custom:Proxy-GLM-5.1-27", "Proxy - GLM-5.1", true],
    ]);
    expect(models[0]?.subProvider).toBe("Factory");
    expect(models[1]?.subProvider).toBe("Custom");
    expect(models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "reasoningEffort",
      currentValue: "high",
      options: [
        { id: "off", label: "Off" },
        { id: "high", label: "High", isDefault: true },
      ],
    });
  });
});
