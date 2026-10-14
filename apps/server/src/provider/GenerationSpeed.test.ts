import { describe, expect, it } from "@effect/vitest";
import {
  ClaudeGenerationSpeed,
  CodexGenerationSpeed,
  GenerationSpeedAccumulator,
} from "./GenerationSpeed.ts";

describe("generation speed", () => {
  it("weights model responses by generation time and excludes gaps between requests", () => {
    const speed = new GenerationSpeedAccumulator();
    speed.add(100, 1_000, 2_000);
    speed.add(300, 100_000, 106_000);
    expect(speed.summary()).toEqual({
      outputTokens: 400,
      durationMs: 7_000,
      responses: 2,
      startedAt: "1970-01-01T00:00:01.000Z",
    });
  });

  it("omits buffered, empty, reversed, and invalid samples", () => {
    const speed = new GenerationSpeedAccumulator();
    speed.add(100, 1_000, 1_050);
    speed.add(0, 1_000, 2_000);
    speed.add(100, 2_000, 1_000);
    speed.add(Number.NaN, 1_000, 2_000);
    expect(speed.summary()).toBeUndefined();
  });

  it("closes Codex generation before approvals and tool execution", () => {
    const speed = new CodexGenerationSpeed();
    speed.startItem("reasoning", 1_000);
    speed.completeItem("reasoning", 2_000);
    speed.startItem("commandExecution", 3_000);
    speed.completeItem("commandExecution", 63_000);
    speed.startItem("mcpToolCall", 63_000);
    speed.completeItem("mcpToolCall", 120_000);
    speed.completeResponse(100, 60);
    speed.completeResponse(0, 0);
    expect(speed.summary()).toMatchObject({ outputTokens: 100, durationMs: 2_000, responses: 1 });
  });

  it("does not assign hidden Codex reasoning tokens to a visible-only interval", () => {
    const speed = new CodexGenerationSpeed();
    speed.startItem("agentMessage", 1_000);
    speed.completeItem("agentMessage", 2_000);
    speed.completeResponse(1_000, 900);
    expect(speed.summary()).toBeUndefined();
    speed.startItem("agentMessage", 3_000);
    speed.completeItem("agentMessage", 4_000);
    speed.completeResponse(100, 0);
    expect(speed.summary()).toMatchObject({ outputTokens: 100, durationMs: 1_000 });
  });

  it("uses Claude's final counts once and removes tokens already generated at message start", () => {
    const speed = new ClaudeGenerationSpeed();
    speed.startResponse(1_000, 8);
    speed.contentDelta(2_000);
    speed.contentDelta(3_000);
    speed.completeResponse(108);
    speed.completeResponse(108);
    // An interrupted message has no final count, so it contributes no sample.
    speed.startResponse(100_000, 1);
    speed.contentDelta(102_000);
    expect(speed.summary()).toMatchObject({ outputTokens: 100, durationMs: 2_000, responses: 1 });
  });

  it("discards an incomplete Claude response when the next response starts", () => {
    const speed = new ClaudeGenerationSpeed();
    speed.startResponse(1_000, 1);
    speed.contentDelta(2_000);
    speed.startResponse(10_000, 1);
    speed.contentDelta(12_000);
    speed.completeResponse(101);
    expect(speed.summary()).toMatchObject({ outputTokens: 100, durationMs: 2_000, responses: 1 });
  });
});
