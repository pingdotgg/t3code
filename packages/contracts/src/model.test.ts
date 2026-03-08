import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  ProviderModelOptions,
} from "./model";

const decodeProviderModelOptions = Schema.decodeUnknownSync(ProviderModelOptions);

describe("ProviderModelOptions", () => {
  it("accepts claude code-scoped model options", () => {
    const parsed = decodeProviderModelOptions({
      claudeCode: {},
    });

    expect(parsed.claudeCode).toEqual({});
  });
});

describe("claude code model catalog", () => {
  it("defines built-in options and defaults", () => {
    expect(MODEL_OPTIONS_BY_PROVIDER.claudeCode).toEqual([
      { slug: "sonnet", name: "Sonnet" },
      { slug: "opus", name: "Opus" },
      { slug: "haiku", name: "Haiku" },
      { slug: "sonnet[1m]", name: "Sonnet (1M context)" },
    ]);
    expect(DEFAULT_MODEL_BY_PROVIDER.claudeCode).toBe("sonnet");
  });

  it("maps known full model names back to built-in aliases", () => {
    expect(MODEL_SLUG_ALIASES_BY_PROVIDER.claudeCode["claude-sonnet-4-5-20250929"]).toBe(
      "sonnet",
    );
    expect(
      MODEL_SLUG_ALIASES_BY_PROVIDER.claudeCode[
        "anthropic.claude-sonnet-4-5-20250929-v1:0[1m]"
      ],
    ).toBe("sonnet[1m]");
  });
});