// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { parseCommandCodeModelList } from "./commandCodeModels.ts";

const SAMPLE_LIST = `Available models  ·  3 models

Open Source

deepseek/deepseek-v4-flash   fast hybrid-attention reasoning (default)
z-ai/glm-5.3-flash           fast, affordable GLM coding with 1M context

Anthropic

claude-sonnet-5   best combo of speed & intelligence (recommended)
`;

describe("parseCommandCodeModelList", () => {
  it("parses slugs and drops category headers", () => {
    const models = parseCommandCodeModelList(SAMPLE_LIST);
    expect(models.map((model) => model.slug)).toEqual([
      "deepseek/deepseek-v4-flash",
      "z-ai/glm-5.3-flash",
      "claude-sonnet-5",
    ]);
    expect(models.every((model) => model.isCustom === false && model.capabilities === null)).toBe(
      true,
    );
  });

  it("marks the explicitly-default row, not the first row", () => {
    const models = parseCommandCodeModelList(SAMPLE_LIST);
    expect(models.find((model) => model.isDefault === true)?.slug).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("falls back to the first row as default when no row is marked", () => {
    const models = parseCommandCodeModelList(SAMPLE_LIST.replace("(default)", "(recommended)"));
    expect(models.find((model) => model.isDefault === true)?.slug).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it("tolerates ANSI colors and windows line endings", () => {
    const models = parseCommandCodeModelList(
      "\u001b[32mdeepseek/deepseek-v4-flash\u001b[39m   hybrid-attention (default)\r\n" +
        "claude-sonnet-5   recommended\r\n",
    );
    expect(models.map((model) => model.slug)).toEqual([
      "deepseek/deepseek-v4-flash",
      "claude-sonnet-5",
    ]);
  });

  it("returns an empty list for garbage output", () => {
    expect(parseCommandCodeModelList("")).toEqual([]);
    expect(parseCommandCodeModelList("Anthropic\n\nOpen Source\n")).toEqual([]);
  });
});

describe("commandCodeModels fixture", () => {
  it("loads the captured transcript fixture", () => {
    const lines = NodeFS.readFileSync(
      new URL("./testFixtures/commandCodeHeadless/turn-text-success.ndjson", import.meta.url),
      "utf8",
    ).split("\n");
    expect(lines.length).toBeGreaterThan(5);
  });
});
