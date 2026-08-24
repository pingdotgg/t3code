import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  contextWindowSeverityColor,
  formatContextWindowCompactionMessage,
  resolveContextWindowModelDisplayName,
} from "./ContextWindowMeter.logic";

describe("resolveContextWindowModelDisplayName", () => {
  it("uses the selected model from the exact provider instance", () => {
    const primaryInstanceId = ProviderInstanceId.make("codex");
    const selectedInstanceId = ProviderInstanceId.make("codex-work");
    const modelOptionsByInstance = new Map([
      [
        primaryInstanceId,
        [{ slug: "gpt-5.6-sol", name: "Primary profile model", shortName: "Primary" }],
      ],
      [selectedInstanceId, [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", shortName: "5.6 Sol" }]],
    ]);

    expect(
      resolveContextWindowModelDisplayName(
        {
          instanceId: selectedInstanceId,
          model: "gpt-5.6-sol",
        },
        modelOptionsByInstance,
      ),
    ).toBe("5.6 Sol");
  });

  it("falls back to the selected model slug when model metadata is unavailable", () => {
    const selectedInstanceId = ProviderInstanceId.make("codex-work");

    expect(
      resolveContextWindowModelDisplayName(
        {
          instanceId: selectedInstanceId,
          model: "custom-model",
        },
        new Map(),
      ),
    ).toBe("custom-model");
  });
});

describe("formatContextWindowCompactionMessage", () => {
  it("describes compaction in terms of the selected model", () => {
    expect(formatContextWindowCompactionMessage("GPT-5.6 Sol")).toBe(
      "Context for GPT-5.6 Sol compacts automatically when needed.",
    );
  });

  it("uses neutral copy when the model is unavailable", () => {
    expect(formatContextWindowCompactionMessage(null)).toBe(
      "Context compacts automatically when needed.",
    );
  });
});

describe("contextWindowSeverityColor", () => {
  const green = "var(--color-success)";
  const orange = "color-mix(in oklab, var(--color-warning) 50%, var(--color-error))";
  const red = "var(--color-error)";

  it("is green below the 160k threshold", () => {
    expect(contextWindowSeverityColor(0)).toBe(green);
    expect(contextWindowSeverityColor(80_000)).toBe(green);
    expect(contextWindowSeverityColor(159_999)).toBe(green);
  });

  it("is orange from 160k up to the 250k threshold", () => {
    expect(contextWindowSeverityColor(160_000)).toBe(orange);
    expect(contextWindowSeverityColor(205_000)).toBe(orange);
    expect(contextWindowSeverityColor(249_999)).toBe(orange);
  });

  it("is red at and above 250k", () => {
    expect(contextWindowSeverityColor(250_000)).toBe(red);
    expect(contextWindowSeverityColor(900_000)).toBe(red);
  });

  it("ignores how full the model's window is, banding on absolute tokens only", () => {
    // A tiny window can sit at 99% used and still be a small, healthy context.
    expect(contextWindowSeverityColor(8_000)).toBe(green);
  });

  it("treats missing usage as empty rather than severe", () => {
    expect(contextWindowSeverityColor(null)).toBe(green);
  });
});
