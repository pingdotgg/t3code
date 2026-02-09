import { describe, expect, it } from "vitest";

import { buildBootstrapInput } from "./historyBootstrap";

describe("buildBootstrapInput", () => {
  it("includes full transcript when under budget", () => {
    const result = buildBootstrapInput(
      [
        {
          id: "u-1",
          role: "user",
          text: "hello",
          createdAt: "2026-02-09T00:00:00.000Z",
          streaming: false,
        },
        {
          id: "a-1",
          role: "assistant",
          text: "world",
          createdAt: "2026-02-09T00:00:01.000Z",
          streaming: false,
        },
      ],
      "what's next?",
      1_500,
    );

    expect(result.includedCount).toBe(2);
    expect(result.omittedCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain("USER:\nhello");
    expect(result.text).toContain("ASSISTANT:\nworld");
    expect(result.text).toContain("Latest user request (answer this now):");
    expect(result.text).toContain("what's next?");
  });

  it("truncates older transcript messages when over budget", () => {
    const result = buildBootstrapInput(
      [
        {
          id: "u-1",
          role: "user",
          text: "first question with details",
          createdAt: "2026-02-09T00:00:00.000Z",
          streaming: false,
        },
        {
          id: "a-1",
          role: "assistant",
          text: "first answer with details",
          createdAt: "2026-02-09T00:00:01.000Z",
          streaming: false,
        },
        {
          id: "u-2",
          role: "user",
          text: "second question with details",
          createdAt: "2026-02-09T00:00:02.000Z",
          streaming: false,
        },
      ],
      "final request",
      320,
    );

    expect(result.truncated).toBe(true);
    expect(result.omittedCount).toBeGreaterThan(0);
    expect(result.includedCount).toBeLessThan(3);
    expect(result.text).toContain("omitted to stay within input limits");
    expect(result.text.length).toBeLessThanOrEqual(320);
  });

  it("preserves the latest prompt when prompt-only fallback is required", () => {
    const latestPrompt = "Please keep this exact latest prompt.";
    const result = buildBootstrapInput(
      [
        {
          id: "u-1",
          role: "user",
          text: "old context",
          createdAt: "2026-02-09T00:00:00.000Z",
          streaming: false,
        },
      ],
      latestPrompt,
      latestPrompt.length + 3,
    );

    expect(result.text).toBe(latestPrompt);
    expect(result.includedCount).toBe(0);
    expect(result.omittedCount).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
