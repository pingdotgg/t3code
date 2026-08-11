import { describe, expect, it } from "vite-plus/test";

import { buildOmpCliArgs, buildOmpDiscoveredModels, parseOmpModelsJson } from "./OmpProvider.ts";

describe("OmpProvider", () => {
  it("parses OMP's machine-readable model inventory", () => {
    const parsed = parseOmpModelsJson(
      JSON.stringify({
        models: [
          {
            provider: "anthropic",
            id: "claude-sonnet-4-6",
            selector: "anthropic/claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            reasoning: true,
            thinking: ["low", "medium", "high"],
            input: ["text", "image"],
          },
          {
            provider: "local",
            id: "qwen",
            selector: "local/qwen",
            name: "Qwen",
            reasoning: false,
            thinking: null,
            input: ["text"],
          },
        ],
      }),
    );

    expect(parsed).toHaveLength(2);
    expect(buildOmpDiscoveredModels(parsed ?? [])).toEqual([
      {
        slug: "anthropic/claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        subProvider: "anthropic",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinking",
              label: "Thinking",
              description: "Reasoning effort used by OMP for this model.",
              type: "select",
              currentValue: "auto",
              options: [
                { id: "off", label: "Off" },
                { id: "auto", label: "Auto", isDefault: true },
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium" },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      },
      {
        slug: "local/qwen",
        name: "Qwen",
        subProvider: "local",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });

  it("rejects malformed JSON and prepends the selected profile", () => {
    expect(parseOmpModelsJson("not json")).toBeUndefined();
    expect(buildOmpCliArgs({ profile: "work" }, ["models", "--json"])).toEqual([
      "--profile",
      "work",
      "models",
      "--json",
    ]);
    expect(buildOmpCliArgs({ profile: "" }, ["acp"])).toEqual(["acp"]);
  });
});
