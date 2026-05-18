import { ModelProvider, ReasoningEffort, type AvailableModelConfig } from "@factory/droid-sdk";
import { DroidSettings } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  buildDroidModelsFromSdkModels,
  droidDiscoveryFailureMessage,
  makePendingDroidProvider,
} from "./DroidProvider.ts";

const sdkModel = (model: AvailableModelConfig): AvailableModelConfig => model;
const decodeDroidSettings = Schema.decodeSync(DroidSettings);

describe("DroidProvider", () => {
  it("reports disabled pending provider status when Droid is disabled", async () => {
    const settings = decodeDroidSettings({
      enabled: false,
      binaryPath: "fake-droid",
    });
    const provider = await Effect.runPromise(makePendingDroidProvider(settings));

    expect(provider.enabled).toBe(false);
    expect(provider.status).toBe("disabled");
    expect(provider.installed).toBe(false);
    expect(provider.message).toBe("Droid is disabled in T3 Code settings.");
  });

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

  it("keeps unknown Droid SDK model providers displayable", () => {
    const models = buildDroidModelsFromSdkModels([
      sdkModel({
        id: "new-provider-model",
        modelId: "new-provider-model",
        displayName: "New Provider Model",
        shortDisplayName: "New Provider",
        modelProvider: "NEW_PROVIDER" as ModelProvider,
        supportedReasoningEfforts: [ReasoningEffort.None],
        defaultReasoningEffort: ReasoningEffort.None,
        isCustom: false,
      }),
    ]);

    expect(models[0]?.subProvider).toBe("NEW_PROVIDER");
  });

  it("extracts Droid model discovery errors from Effect causes", () => {
    const cause = Cause.fail(new Error("Droid auth expired"));

    expect(droidDiscoveryFailureMessage(cause)).toBe("Droid auth expired");
  });
});
