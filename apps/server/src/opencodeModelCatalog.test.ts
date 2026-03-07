import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseConfiguredOpenCodeModelCatalog,
  parseConnectedOpenCodeModelCatalog,
} from "./opencodeModelCatalog.ts";

describe("parseConnectedOpenCodeModelCatalog", () => {
  it("keeps provider groups and flattens connected provider models", () => {
    const result = parseConnectedOpenCodeModelCatalog({
      all: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            "gpt-5": { id: "gpt-5", name: "GPT-5" },
            "gpt-4.1": { id: "gpt-4.1", name: "GPT-4.1" },
          },
        },
        {
          id: "anthropic",
          name: "Anthropic",
          models: {
            "claude-sonnet-4": { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
          },
        },
      ],
      connected: ["anthropic"],
    });

    assert.deepEqual(result.models, [
      {
        slug: "anthropic/claude-sonnet-4",
        name: "Anthropic / Claude Sonnet 4",
      },
    ]);
    assert.deepEqual(result.modelCatalog, {
      groups: [
        {
          id: "anthropic",
          name: "Anthropic",
          models: [
            {
              slug: "anthropic/claude-sonnet-4",
              name: "Claude Sonnet 4",
            },
          ],
        },
      ],
    });
  });
});

describe("parseConfiguredOpenCodeModelCatalog", () => {
  it("parses provider favorites when the payload includes them", () => {
    const result = parseConfiguredOpenCodeModelCatalog({
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          models: {
            "gpt-5": { id: "gpt-5", name: "GPT-5" },
          },
        },
        {
          id: "anthropic",
          name: "Anthropic",
          models: {
            "claude-sonnet-4": { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
          },
        },
      ],
      favorites: [
        { providerId: "openai", modelId: "gpt-5" },
        "anthropic/claude-sonnet-4",
      ],
    });

    assert.deepEqual(result.modelCatalog, {
      groups: [
        {
          id: "openai",
          name: "OpenAI",
          models: [
            {
              slug: "openai/gpt-5",
              name: "GPT-5",
            },
          ],
        },
        {
          id: "anthropic",
          name: "Anthropic",
          models: [
            {
              slug: "anthropic/claude-sonnet-4",
              name: "Claude Sonnet 4",
            },
          ],
        },
      ],
      favorites: [
        {
          slug: "openai/gpt-5",
          name: "OpenAI / GPT-5",
        },
        {
          slug: "anthropic/claude-sonnet-4",
          name: "Anthropic / Claude Sonnet 4",
        },
      ],
    });
  });
});
