import { describe, expect, it } from "@effect/vitest";

import { subagentCallFromToolCall, subagentOutcomeFromToolResult } from "./subagents.ts";

describe("subagentCallFromToolCall", () => {
  it("creates one subagent for a foreground spawn", () => {
    expect(
      subagentCallFromToolCall("spawn_subagent", { prompt: "review the diff", agent: "reviewer" }),
    ).toEqual({
      prompt: "review the diff",
      title: "reviewer",
      agents: ["reviewer"],
    });
  });

  it("creates none for a background delegate", () => {
    expect(
      subagentCallFromToolCall("delegate", {
        action: "delegate",
        prompt: "look around",
        background: true,
      }),
    ).toBeNull();
  });

  it("creates none for a non-delegate action or an empty prompt", () => {
    expect(subagentCallFromToolCall("delegate", { action: "list", prompt: "x" })).toBeNull();
    expect(subagentCallFromToolCall("spawn_subagent", { prompt: "   " })).toBeNull();
    expect(subagentCallFromToolCall("shell", { command: "ls" })).toBeNull();
  });

  it("lists every agent in a parallel delegate title", () => {
    expect(
      subagentCallFromToolCall("delegate", {
        action: "delegate",
        prompt: "compare",
        parallel: ["alpha", "beta"],
      }),
    ).toEqual({
      prompt: "compare",
      title: "alpha, beta",
      agents: ["alpha", "beta"],
    });
  });
});

describe("subagentOutcomeFromToolResult", () => {
  it("settles a string result as completed", () => {
    expect(subagentOutcomeFromToolResult("done")).toEqual({ status: "completed", result: "done" });
  });

  it("settles a failed payload as failed", () => {
    expect(subagentOutcomeFromToolResult({ status: "failed", error: "boom" })).toEqual({
      status: "failed",
      result: "boom",
    });
  });
});
