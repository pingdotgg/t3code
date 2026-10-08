import { assert, describe, it } from "@effect/vitest";

import { thinkingCapabilitiesForPiModel } from "./piThinkingCapabilities.ts";

describe("thinkingCapabilitiesForPiModel", () => {
  it("gives every choice its real level id and tags Pi's default", () => {
    const capabilities = thinkingCapabilitiesForPiModel(
      {
        reasoning: true,
        thinkingLevelMap: { off: null, xhigh: "extra_high", max: null },
      },
      "xhigh",
    );
    const descriptors = capabilities.optionDescriptors ?? [];
    const thinking = descriptors[0];
    assert.equal(thinking?.id, "thinking");
    assert.equal(thinking?.type, "select");
    if (thinking?.type !== "select") return;
    assert.deepEqual(
      thinking.options.map((option) => [option.id, option.label, option.isDefault === true]),
      [
        ["minimal", "Minimal", false],
        ["low", "Low", false],
        ["medium", "Medium", false],
        ["high", "High", false],
        ["xhigh", "Extra High", true],
      ],
    );
  });

  it("clamps Pi's default to each model's supported levels", () => {
    const capabilities = thinkingCapabilitiesForPiModel(
      {
        reasoning: true,
        thinkingLevelMap: { xhigh: "extra_high", max: null },
      },
      "max",
    );
    const thinking = capabilities.optionDescriptors?.[0];
    assert.equal(thinking?.type, "select");
    if (thinking?.type !== "select") return;
    assert.deepInclude(thinking.options, {
      id: "xhigh",
      label: "Extra High",
      isDefault: true,
    });
    assert.notInclude(
      thinking.options.map((option) => option.id),
      "max",
    );
  });
});
