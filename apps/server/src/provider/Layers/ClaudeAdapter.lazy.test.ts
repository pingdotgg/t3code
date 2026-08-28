import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  throw new Error("Claude SDK loaded eagerly.");
});

describe("ClaudeAdapter module loading", () => {
  it("does not load the Claude SDK while importing the adapter", async () => {
    await expect(import("./ClaudeAdapter.ts")).resolves.toMatchObject({
      makeClaudeAdapter: expect.any(Function),
    });
  });
});
