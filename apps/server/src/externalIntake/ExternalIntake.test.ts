import { describe, expect, it } from "vitest";

import { modelSelectionFromIntakeTags } from "./ExternalIntake.ts";

describe("modelSelectionFromIntakeTags", () => {
  it("returns undefined when no routing tag is present", () => {
    expect(modelSelectionFromIntakeTags("please add dark mode")).toBeUndefined();
  });

  it.each([
    ["codex-fast", "medium", "priority"],
    ["codex", "medium", "default"],
    ["codex-high-fast", "high", "priority"],
    ["codex-high", "high", "default"],
  ])("routes [%s] to GPT-5.5 with the requested Codex traits", (tag, reasoning, serviceTier) => {
    expect(modelSelectionFromIntakeTags(`[${tag}] fix the build`)).toEqual({
      instanceId: "codex",
      model: "gpt-5.5",
      options: [
        { id: "reasoningEffort", value: reasoning },
        { id: "serviceTier", value: serviceTier },
      ],
    });
  });

  it.each([
    ["codex-fast", "medium", "priority"],
    ["codex", "medium", "default"],
    ["codex-high-fast", "high", "priority"],
    ["codex-high", "high", "default"],
  ])(
    "routes a leading %s: prefix to GPT-5.5 with the requested Codex traits",
    (tag, reasoning, serviceTier) => {
      expect(modelSelectionFromIntakeTags(`${tag}: fix the build`)).toEqual({
        instanceId: "codex",
        model: "gpt-5.5",
        options: [
          { id: "reasoningEffort", value: reasoning },
          { id: "serviceTier", value: serviceTier },
        ],
      });
    },
  );

  it("routes [claude] to Opus 4.8 at extra-high effort", () => {
    expect(modelSelectionFromIntakeTags("[claude] refactor the parser")).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-4-8",
      options: [{ id: "effort", value: "xhigh" }],
    });
  });

  it.each([
    ["claude", "claude-opus-4-8", "xhigh"],
    ["claude-opus", "claude-opus-4-8", "xhigh"],
    ["claude-opus-high", "claude-opus-4-8", "high"],
    ["claude-opus-ultracode", "claude-opus-4-8", "ultracode"],
    ["claude-fable", "claude-fable-5", "high"],
    ["claude-fable-xhigh", "claude-fable-5", "xhigh"],
    ["claude-fable-ultracode", "claude-fable-5", "ultracode"],
  ])("routes [%s] to the requested Claude model and effort", (tag, model, effort) => {
    expect(modelSelectionFromIntakeTags(`[${tag}] refactor the parser`)).toEqual({
      instanceId: "claudeAgent",
      model,
      options: [{ id: "effort", value: effort }],
    });
  });

  it.each([
    ["claude", "claude-opus-4-8", "xhigh"],
    ["claude-opus", "claude-opus-4-8", "xhigh"],
    ["claude-opus-high", "claude-opus-4-8", "high"],
    ["claude-opus-ultracode", "claude-opus-4-8", "ultracode"],
    ["claude-fable", "claude-fable-5", "high"],
    ["claude-fable-xhigh", "claude-fable-5", "xhigh"],
    ["claude-fable-ultracode", "claude-fable-5", "ultracode"],
  ])(
    "routes a leading %s: prefix to the requested Claude model and effort",
    (tag, model, effort) => {
      expect(modelSelectionFromIntakeTags(`${tag}: refactor the parser`)).toEqual({
        instanceId: "claudeAgent",
        model,
        options: [{ id: "effort", value: effort }],
      });
    },
  );

  it("is case-insensitive and matches tags anywhere in the message", () => {
    expect(modelSelectionFromIntakeTags("ship it [CODEX-HIGH-FAST] now")).toMatchObject({
      instanceId: "codex",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "priority" },
      ],
    });
    expect(modelSelectionFromIntakeTags("ship it [Claude] now")?.instanceId).toBe("claudeAgent");
  });

  it("prefers whichever tag appears first when both are present", () => {
    expect(modelSelectionFromIntakeTags("[codex-high] vs [claude]")).toMatchObject({
      instanceId: "codex",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "default" },
      ],
    });
    expect(modelSelectionFromIntakeTags("[claude] vs [codex]")?.instanceId).toBe("claudeAgent");
    expect(modelSelectionFromIntakeTags("[claude] then codex-fast: do this")?.instanceId).toBe(
      "claudeAgent",
    );
  });

  it("ignores bare words without brackets", () => {
    expect(modelSelectionFromIntakeTags("use codex or claude here")).toBeUndefined();
  });

  it("does not expose ultrathink routing tags", () => {
    expect(modelSelectionFromIntakeTags("[claude-opus-ultrathink] fix the build")).toBeUndefined();
    expect(modelSelectionFromIntakeTags("claude-fable-ultrathink: fix the build")).toBeUndefined();
  });
});
