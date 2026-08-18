import { describe, expect, it } from "vite-plus/test";
import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";

import {
  deriveProviderModelsForDisplay,
  reconcileCustomModelCapabilities,
} from "./ProviderInstanceCard";

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
        customModels: ["server-model", "kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });

  it("uses current config capabilities while the live custom row is stale", () => {
    const capabilities: ModelCapabilities = {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [{ id: "high", label: "High", isDefault: true }],
        },
      ],
    };
    const input = {
      liveModels: [
        {
          slug: "gateway/model",
          name: "gateway/model",
          isCustom: true,
          capabilities: null,
        },
      ],
      customModels: ["gateway/model"],
      customModelCapabilities: { "gateway/model": capabilities },
    } satisfies Parameters<typeof deriveProviderModelsForDisplay>[0] & {
      readonly customModelCapabilities: Readonly<Record<string, ModelCapabilities>>;
    };

    expect(deriveProviderModelsForDisplay(input)[0]?.capabilities).toEqual(capabilities);
  });

  it("preserves arbitrary capabilities in optimistic custom rows", () => {
    const capabilities: ModelCapabilities = {
      optionDescriptors: [
        {
          id: "temperature",
          label: "Temperature",
          type: "select",
          options: [{ id: "warm", label: "Warm" }],
        },
      ],
    };
    const [model] = deriveProviderModelsForDisplay({
      liveModels: [],
      customModels: ["vendor/preview"],
      customModelCapabilities: { "vendor/preview": capabilities },
    });

    expect(model?.capabilities).toEqual(capabilities);
  });

  it("keeps legacy metadata absent and seeds newly added models with no controls", () => {
    const configured: ModelCapabilities = {
      optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
    };

    expect(
      reconcileCustomModelCapabilities({
        capabilities: { configured, removed: { optionDescriptors: [] } },
        currentModels: ["legacy", "configured", "removed"],
        nextModels: ["legacy", "configured", "new"],
      }),
    ).toEqual({
      configured,
      new: { optionDescriptors: [] },
    });
  });

  it("stores reserved model IDs as own capability keys", () => {
    const capabilities = reconcileCustomModelCapabilities({
      capabilities: {},
      currentModels: [],
      nextModels: ["__proto__", "constructor"],
    });

    expect(Object.hasOwn(capabilities, "__proto__")).toBe(true);
    expect(capabilities["__proto__"]).toEqual({ optionDescriptors: [] });
    expect(Object.hasOwn(capabilities, "constructor")).toBe(true);
    expect(capabilities.constructor).toEqual({ optionDescriptors: [] });
  });

  it("does not read inherited properties as configured capabilities", () => {
    const [model] = deriveProviderModelsForDisplay({
      liveModels: [],
      customModels: ["constructor"],
      customModelCapabilities: {},
    });

    expect(model?.capabilities).toBeNull();
  });
});
