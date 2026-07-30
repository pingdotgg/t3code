import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";

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

  it("applies persisted labels over live custom model names", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "kept-custom",
        name: "Server Name",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom", "new-custom"],
        customModelLabels: {
          "kept-custom": "Friendly Kept",
          "new-custom": "Friendly New",
        },
      }),
    ).toMatchObject([
      { slug: "kept-custom", name: "Friendly Kept", isCustom: true },
      { slug: "new-custom", name: "Friendly New", isCustom: true },
    ]);
  });
});
