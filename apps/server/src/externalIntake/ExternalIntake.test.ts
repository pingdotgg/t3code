import { describe, expect, it } from "vitest";

import { modelSelectionFromIntakeTags } from "./ExternalIntake.ts";

describe("modelSelectionFromIntakeTags", () => {
  it("returns undefined when no routing tag is present", () => {
    expect(modelSelectionFromIntakeTags("please add dark mode")).toBeUndefined();
  });

  it("routes [codex] to GPT-5.5 fast", () => {
    expect(modelSelectionFromIntakeTags("[codex] fix the build")).toEqual({
      instanceId: "codex",
      model: "gpt-5.5",
      options: [{ id: "serviceTier", value: "fast" }],
    });
  });

  it("routes [claude] to Opus 4.8 at extra-high effort", () => {
    expect(modelSelectionFromIntakeTags("[claude] refactor the parser")).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-4-8",
      options: [{ id: "effort", value: "xhigh" }],
    });
  });

  it("is case-insensitive and matches tags anywhere in the message", () => {
    expect(modelSelectionFromIntakeTags("ship it [CODEX] now")?.instanceId).toBe("codex");
    expect(modelSelectionFromIntakeTags("ship it [Claude] now")?.instanceId).toBe("claudeAgent");
  });

  it("prefers whichever tag appears first when both are present", () => {
    expect(modelSelectionFromIntakeTags("[codex] vs [claude]")?.instanceId).toBe("codex");
    expect(modelSelectionFromIntakeTags("[claude] vs [codex]")?.instanceId).toBe("claudeAgent");
  });

  it("ignores bare words without brackets", () => {
    expect(modelSelectionFromIntakeTags("use codex or claude here")).toBeUndefined();
  });
});
