import { describe, expect, it } from "vite-plus/test";

import { buildThreadSubtitlePrompt, sanitizeThreadSubtitle } from "./ThreadSubtitleGeneration.ts";

describe("thread subtitle generation", () => {
  it("separates the durable mission from the current work phase", () => {
    const result = buildThreadSubtitlePrompt({
      missionTitle: "Session grid",
      context: "USER: Add generated subtitles\n\nASSISTANT: Wiring projection persistence",
      phase: "working",
    });

    expect(result.prompt).toContain('Mission title: "Session grid"');
    expect(result.prompt).toContain("Phase: work is running");
    expect(result.prompt).toContain("Wiring projection persistence");
  });

  it("normalizes model output for dense thread chrome", () => {
    expect(sanitizeThreadSubtitle('Status: "running focused tests..."')).toBe(
      "running focused tests",
    );
    expect(sanitizeThreadSubtitle("   ")).toBe("");
    expect(sanitizeThreadSubtitle("x".repeat(90))).toHaveLength(72);
  });
});
