import { describe, expect, it } from "vitest";

import { classifyCodexStderrLine, normalizeCodexModelSlug } from "./codexAppServerManager";

describe("classifyCodexStderrLine", () => {
  it("ignores empty lines", () => {
    expect(classifyCodexStderrLine("   ")).toBeNull();
  });

  it("ignores non-error structured codex logs", () => {
    const line =
      "2026-02-08T04:24:19.241256Z  WARN codex_core::features: unknown feature key in config: skills";
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("ignores known benign rollout path errors", () => {
    const line =
      "\u001b[2m2026-02-08T04:24:20.085687Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_core::rollout::list\u001b[0m: state db missing rollout path for thread 019c3b6c-46b8-7b70-ad23-82f824d161fb";
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("keeps unknown structured errors", () => {
    const line = "2026-02-08T04:24:20.085687Z ERROR codex_core::runtime: unrecoverable failure";
    expect(classifyCodexStderrLine(line)).toEqual({
      message: line,
    });
  });

  it("keeps plain stderr messages", () => {
    const line = "fatal: permission denied";
    expect(classifyCodexStderrLine(line)).toEqual({
      message: line,
    });
  });
});

describe("normalizeCodexModelSlug", () => {
  it("maps 5.3 aliases to gpt-5.3-codex", () => {
    expect(normalizeCodexModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeCodexModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
  });

  it("prefers codex id when model differs", () => {
    expect(normalizeCodexModelSlug("gpt-5.3", "gpt-5.3-codex")).toBe("gpt-5.3-codex");
  });

  it("keeps non-aliased models as-is", () => {
    expect(normalizeCodexModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
    expect(normalizeCodexModelSlug("gpt-5.2")).toBe("gpt-5.2");
  });
});
