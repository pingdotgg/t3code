import { describe, expect, it } from "vitest";

import { getOpencodeModelCatalog, getOpencodeModelDisplayName } from "./opencodeModelCatalog";

describe("getOpencodeModelCatalog", () => {
  it("uses the structured catalog from the server when available", () => {
    const catalog = getOpencodeModelCatalog({
      provider: "opencode",
      status: "ready",
      available: true,
      authStatus: "unknown",
      checkedAt: "2026-03-07T00:00:00.000Z",
      modelCatalog: {
        groups: [
          {
            id: "openai",
            name: "OpenAI",
            models: [{ slug: "openai/gpt-5", name: "GPT-5" }],
          },
        ],
        favorites: [{ slug: "openai/gpt-5", name: "OpenAI / GPT-5" }],
      },
    });

    expect(catalog).toEqual({
      groups: [
        {
          id: "openai",
          name: "OpenAI",
          models: [{ slug: "openai/gpt-5", name: "GPT-5" }],
        },
      ],
      favorites: [{ slug: "openai/gpt-5", name: "OpenAI / GPT-5" }],
    });
  });

  it("rebuilds provider groups from the flat model list when needed", () => {
    const catalog = getOpencodeModelCatalog({
      provider: "opencode",
      status: "ready",
      available: true,
      authStatus: "unknown",
      checkedAt: "2026-03-07T00:00:00.000Z",
      models: [
        { slug: "openai/gpt-5", name: "OpenAI / GPT-5" },
        { slug: "anthropic/claude-sonnet-4", name: "Anthropic / Claude Sonnet 4" },
      ],
    });

    expect(catalog).toEqual({
      groups: [
        {
          id: "openai",
          name: "OpenAI",
          models: [{ slug: "openai/gpt-5", name: "GPT-5" }],
        },
        {
          id: "anthropic",
          name: "Anthropic",
          models: [{ slug: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" }],
        },
      ],
    });
  });
});

describe("getOpencodeModelDisplayName", () => {
  it("formats the selected provider and model from grouped catalog data", () => {
    expect(
      getOpencodeModelDisplayName(
        {
          groups: [
            {
              id: "anthropic",
              name: "Anthropic",
              models: [{ slug: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" }],
            },
          ],
        },
        "anthropic/claude-sonnet-4",
      ),
    ).toBe("Anthropic / Claude Sonnet 4");
  });
});
