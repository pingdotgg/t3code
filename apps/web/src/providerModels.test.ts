import {
  ProviderDriverKind,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getProviderOptionCurrentValue,
  buildProviderOptionSelectionsFromDescriptors,
} from "@t3tools/shared/model";
import { getProviderModelCapabilities } from "./providerModels";

const PROVIDER = ProviderDriverKind.make("claudeAgent");

function capabilities(id: string): ModelCapabilities {
  return {
    optionDescriptors: [{ id, label: id, type: "boolean" }],
  };
}

function model(input: {
  slug: string;
  capabilities: ModelCapabilities;
  aliases?: ReadonlyArray<string>;
  isCustom?: boolean;
}): ServerProviderModel {
  return {
    slug: input.slug,
    name: input.slug,
    ...(input.aliases ? { aliases: [...input.aliases] } : {}),
    isCustom: input.isCustom ?? false,
    capabilities: input.capabilities,
  };
}

describe("getProviderModelCapabilities", () => {
  it.each([undefined, "plan"])(
    "keeps an unset agent unset when Plan is hidden (current: %s)",
    (currentValue) => {
      const models = [
        model({
          slug: "opencode/test",
          capabilities: {
            optionDescriptors: [
              {
                id: "agent",
                label: "Agent",
                type: "select",
                options: [
                  { id: "assistant2", label: "Assistant 2" },
                  { id: "plan", label: "Plan" },
                ],
                ...(currentValue ? { currentValue } : {}),
              },
            ],
          },
        }),
      ];
      const caps = getProviderModelCapabilities(
        models,
        "opencode/test",
        ProviderDriverKind.make("opencode"),
        false,
      );
      const descriptor = caps.optionDescriptors?.[0];
      expect(getProviderOptionCurrentValue(descriptor)).toBeUndefined();
      expect(buildProviderOptionSelectionsFromDescriptors(caps.optionDescriptors)).toBeUndefined();
    },
  );

  it("resolves model-declared aliases", () => {
    const aliasCapabilities = capabilities("aliased-option");
    const models = [
      model({
        slug: "synthetic-model",
        aliases: ["Legacy-Synthetic-Model"],
        capabilities: aliasCapabilities,
      }),
    ];

    expect(getProviderModelCapabilities(models, "legacy-synthetic-model", PROVIDER)).toEqual(
      aliasCapabilities,
    );
  });

  it("prefers an exact custom slug over a built-in model alias", () => {
    const customCapabilities = capabilities("custom-option");
    const models = [
      model({
        slug: "synthetic-model",
        aliases: ["custom-model"],
        capabilities: capabilities("built-in-option"),
      }),
      model({ slug: "custom-model", capabilities: customCapabilities, isCustom: true }),
    ];

    expect(getProviderModelCapabilities(models, " custom-model ", PROVIDER)).toEqual(
      customCapabilities,
    );
  });
});
