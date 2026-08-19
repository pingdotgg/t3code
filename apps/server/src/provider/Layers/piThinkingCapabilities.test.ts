import { assert, describe, it } from "@effect/vitest";

import {
  EMPTY_PI_MODEL_CAPABILITIES,
  thinkingCapabilitiesForPiModel,
} from "./piThinkingCapabilities.ts";

describe("thinkingCapabilitiesForPiModel", () => {
  it("returns empty capabilities for a non-reasoning model", () => {
    assert.deepEqual(
      thinkingCapabilitiesForPiModel({ reasoning: false }, "xhigh"),
      EMPTY_PI_MODEL_CAPABILITIES,
    );
  });

  it("shows Pi's resolved default as the default choice while keeping it inherited", () => {
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
        ["inherit", "Extra High", true],
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
      id: "inherit",
      label: "Extra High",
      isDefault: true,
    });
    assert.notInclude(
      thinking.options.map((option) => option.id),
      "xhigh",
    );
  });
});
