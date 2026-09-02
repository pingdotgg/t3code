import { describe, expect, it } from "vite-plus/test";

import { buildContinuationPrompt, splitLeadingCdForPrompt } from "./continuation-prompt";

describe("splitLeadingCdForPrompt", () => {
  it("separates a leading cd from the command", () => {
    expect(splitLeadingCdForPrompt("cd /repo/apps/mobile && pnpm test")).toEqual({
      cwd: "/repo/apps/mobile",
      command: "pnpm test",
    });
    expect(splitLeadingCdForPrompt("ls -la")).toEqual({ cwd: null, command: "ls -la" });
  });
});

describe("buildContinuationPrompt", () => {
  it("names the interrupted command and directory", () => {
    expect(
      buildContinuationPrompt({
        reason: "interrupted",
        command: "pnpm expo start --clear",
        cwd: "apps/mobile",
      }),
    ).toBe(
      "Your previous turn was stopped before it finished. You were running `pnpm expo start --clear` in apps/mobile. Continue from that step. Do not repeat work that already completed, and do not re-run commands whose results are already in this conversation unless you need fresh output.",
    );
  });

  it("falls back to the tool label, then to a bare continuation", () => {
    expect(
      buildContinuationPrompt({ reason: "error", toolLabel: "Changed files: src/a.ts" }),
    ).toContain("You were in the middle of: Changed files: src/a.ts.");
    expect(buildContinuationPrompt({ reason: "error" })).toBe(
      "Your previous turn ended with an error before it finished. Continue from that step. Do not repeat work that already completed, and do not re-run commands whose results are already in this conversation unless you need fresh output.",
    );
  });
});
