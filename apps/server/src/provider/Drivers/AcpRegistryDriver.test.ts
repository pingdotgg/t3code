import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import { buildModelsFromAcpConfigOptions } from "./AcpRegistryDriver.ts";

describe("buildModelsFromAcpConfigOptions", () => {
  it("builds provider models from ACP model select options", () => {
    const configOptions = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "composer-2",
        options: [
          { value: "default", name: "Auto" },
          { value: "composer-2", name: "Composer 2" },
          { value: "gpt-5.4", name: "GPT-5.4" },
        ],
      },
    ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

    expect(buildModelsFromAcpConfigOptions(configOptions)).toMatchObject([
      { slug: "default", name: "Auto", isCustom: false },
      { slug: "composer-2", name: "Composer 2", isCustom: false },
      { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false },
    ]);
  });

  it("flattens grouped ACP model options and de-duplicates values", () => {
    const configOptions = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "composer-2",
        options: [
          {
            group: "recommended",
            name: "Recommended",
            options: [
              { value: "composer-2", name: "Composer 2" },
              { value: "gpt-5.4", name: "GPT-5.4" },
            ],
          },
          {
            group: "legacy",
            name: "Legacy",
            options: [
              { value: "composer-2", name: "Composer 2 Duplicate" },
              { value: "legacy", name: "Legacy" },
            ],
          },
        ],
      },
    ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

    expect(buildModelsFromAcpConfigOptions(configOptions).map((model) => model.slug)).toEqual([
      "composer-2",
      "gpt-5.4",
      "legacy",
    ]);
  });

  it("returns an empty list when the ACP agent does not advertise a model selector", () => {
    expect(
      buildModelsFromAcpConfigOptions([
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "ask",
          options: [{ value: "ask", name: "Ask" }],
        },
      ]),
    ).toEqual([]);
  });

  it("matches by id=model when category is absent (Junie spec compliance)", () => {
    // ACP spec: `category` is optional. Junie returns id="model" with no category.
    const configOptions = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "gemini-3-flash-preview",
        options: [
          { value: "gemini-3-flash-preview", name: "Gemini 3 Flash" },
          { value: "claude-opus-4-7", name: "Claude Opus 4.7" },
        ],
      },
    ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

    expect(buildModelsFromAcpConfigOptions(configOptions).map((m) => m.slug)).toEqual([
      "gemini-3-flash-preview",
      "claude-opus-4-7",
    ]);
  });
});
