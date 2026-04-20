import { describe, expect, it } from "vitest";

import { DEFAULT_OPENCODE_MODEL_CAPABILITIES, flattenOpenCodeModels } from "./opencodeRuntime.ts";

describe("flattenOpenCodeModels", () => {
  it("keeps the canonical model name separate from the subprovider label", () => {
    const models = flattenOpenCodeModels({
      providerList: {
        connected: ["github-copilot"],
        all: [
          {
            id: "github-copilot",
            name: "GitHub Copilot",
            models: {
              "claude-opus-4.5": {
                id: "claude-opus-4.5",
                name: "Claude Opus 4.5",
                variants: {},
              },
            },
          },
        ],
      },
      agents: [],
    } as unknown as Parameters<typeof flattenOpenCodeModels>[0]);

    expect(models).toEqual([
      {
        slug: "github-copilot/claude-opus-4.5",
        name: "Claude Opus 4.5",
        subProvider: "GitHub Copilot",
        isCustom: false,
        capabilities: DEFAULT_OPENCODE_MODEL_CAPABILITIES,
      },
    ]);
  });
});
