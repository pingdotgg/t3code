import { describe, expect, it } from "@effect/vitest";

import { claudeCodexUpstreamPath, classifyClaudeCodexUpstream } from "./HybridRouter.ts";

const isCodex = (model: string) => model.startsWith("gpt-") || model === "o3";

describe("ClaudeCodexHybridRouter", () => {
  it("routes verified Codex ids to the local bridge", () => {
    expect(classifyClaudeCodexUpstream("gpt-5.6-sol", isCodex)).toBe("codex");
    expect(classifyClaudeCodexUpstream("o3", isCodex)).toBe("codex");
  });

  it("keeps Claude aliases and full ids on Anthropic", () => {
    expect(classifyClaudeCodexUpstream("opus", isCodex)).toBe("anthropic");
    expect(classifyClaudeCodexUpstream("claude-opus-5[1m]", isCodex)).toBe("anthropic");
  });

  it("rejects missing and unknown models instead of leaking credentials", () => {
    expect(classifyClaudeCodexUpstream(undefined, isCodex)).toBe("reject");
    expect(classifyClaudeCodexUpstream("mystery-model", isCodex)).toBe("reject");
  });

  it("preserves a configured Claude-compatible upstream path", () => {
    expect(claudeCodexUpstreamPath("/api", "/v1/messages?beta=true")).toBe(
      "/api/v1/messages?beta=true",
    );
    expect(claudeCodexUpstreamPath("/", "/v1/models")).toBe("/v1/models");
  });
});
