import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";

import { deriveProviderModelsForDisplay } from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });

  it("shows one grouped Antigravity row and suppresses its raw effort variants", () => {
    const grouped: ServerProviderModel = {
      slug: "gemini-3.7-flash-high",
      name: "Gemini 3.7 Flash",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
            ],
            currentValue: "high",
          },
        ],
      },
    };

    expect(
      deriveProviderModelsForDisplay({
        driverKind: ProviderDriverKind.make("agy"),
        liveModels: [
          grouped,
          {
            slug: "gemini-3.7-flash-medium",
            name: "Gemini 3.7 Flash (Medium)",
            isCustom: false,
            capabilities: null,
          },
        ],
        customModels: ["gemini-3.7-flash-low", "my-custom-model"],
      }).map((model) => model.slug),
    ).toEqual(["gemini-3.7-flash-high", "my-custom-model"]);
  });
});
