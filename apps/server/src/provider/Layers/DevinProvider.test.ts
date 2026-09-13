import { describe, expect, it } from "@effect/vitest";

import { parseDevinModelsCliOutput } from "./DevinProvider.ts";

describe("Devin provider probes", () => {
  it("parses authenticated models from devin models list output", () => {
    const result = parseDevinModelsCliOutput(`
You are logged in with Devin.
Available models:
  * devin-4.6 (default)
  - devin-4.5
`);

    expect(result.authenticated).toBe(true);
    expect(result.models.map((model) => model.slug)).toEqual(["devin-4.6", "devin-4.5"]);
    expect(result.models[0]?.isDefault).toBe(true);
  });

  it("parses every selectable model row from grouped CLI output", () => {
    const result = parseDevinModelsCliOutput(`
Available models (2 families)

GPT-5.6 Sol (gpt-5.6-sol)
  aliases: gpt
  gpt-5-6-sol-medium                 GPT-5.6 Sol Medium Thinking  [1M context, $1.2 / 1M Input]
  gpt-5-6-sol-high-priority          GPT-5.6 Sol High Thinking Fast  [1M context, $8 / 1M Input]

GPT-5.3-Codex (gpt-5.3-codex)
  aliases: codex
  gpt-5-3-codex-xhigh                 GPT-5.3-Codex X-High  [400K context, $1.75 / 1M Input]
`);

    expect(result.models).toMatchObject([
      { slug: "gpt-5-6-sol-medium", name: "GPT-5.6 Sol Medium Thinking" },
      { slug: "gpt-5-6-sol-high-priority", name: "GPT-5.6 Sol High Thinking Fast" },
      { slug: "gpt-5-3-codex-xhigh", name: "GPT-5.3-Codex X-High" },
    ]);
    expect(result.models).toHaveLength(3);
  });

  it("uses the explicit default model while ignoring family aliases", () => {
    const result = parseDevinModelsCliOutput(`
Default model: MODEL_GPT_5_2_MEDIUM
GPT-5.2 (gpt-5.2)
  aliases: gpt
  MODEL_GPT_5_2_LOW                   GPT-5.2 Low Thinking  [384K context]
  MODEL_GPT_5_2_MEDIUM                GPT-5.2 Medium Thinking  [384K context]
`);

    expect(result.models.map((model) => model.slug)).toEqual([
      "MODEL_GPT_5_2_LOW",
      "MODEL_GPT_5_2_MEDIUM",
    ]);
    expect(result.models[1]?.isDefault).toBe(true);
  });
});
