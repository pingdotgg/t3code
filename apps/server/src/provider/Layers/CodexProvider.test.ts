import { describe, expect, it } from "vitest";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { parseCodexModelListResponse } from "./CodexProvider.ts";

function makeModel(
  overrides: Partial<CodexSchema.V2ModelListResponse__Model> = {},
): CodexSchema.V2ModelListResponse__Model {
  return {
    id: "gpt-5.4",
    model: "gpt-5.4",
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: "gpt-5.4",
    description: "Latest frontier agentic coding model.",
    hidden: false,
    supportedReasoningEfforts: [
      {
        reasoningEffort: "medium",
        description: "Balances speed and reasoning depth for everyday tasks",
      },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    supportsPersonality: true,
    isDefault: true,
    ...overrides,
  };
}

describe("parseCodexModelListResponse", () => {
  it("preserves fast mode for GPT-5 models when app-server omits additionalSpeedTiers", () => {
    const [model] = parseCodexModelListResponse({
      data: [makeModel()],
      nextCursor: null,
    });

    expect(model).toBeDefined();
    expect(model?.capabilities).toBeDefined();
    expect(model?.capabilities?.optionDescriptors).toContainEqual(
      expect.objectContaining({ id: "fastMode", type: "boolean" }),
    );
  });

  it("honors an explicit empty additionalSpeedTiers list", () => {
    const [model] = parseCodexModelListResponse({
      data: [
        makeModel({
          additionalSpeedTiers: [],
        }),
      ],
      nextCursor: null,
    });

    expect(model).toBeDefined();
    expect(model?.capabilities).toBeDefined();
    expect(model?.capabilities?.optionDescriptors).not.toContainEqual(
      expect.objectContaining({ id: "fastMode" }),
    );
  });
});
