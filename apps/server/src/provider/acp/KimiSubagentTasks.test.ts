import { describe, expect, it } from "vite-plus/test";

import {
  detectKimiSubagentToolCall,
  extractSubagentSummary,
  truncateSubagentSummary,
} from "./KimiSubagentTasks.ts";

describe("detectKimiSubagentToolCall", () => {
  it("detects an Agent tool call from rawInput with description", () => {
    const info = detectKimiSubagentToolCall({
      title: "Launching coder agent: fix the bug",
      data: {
        rawInput: {
          description: "fix the bug",
          prompt: "please fix the bug in src/foo.ts",
          subagent_type: "coder",
        },
      },
    });

    expect(info).toEqual({
      kind: "agent",
      subagentType: "coder",
      description: "fix the bug",
    });
  });

  it("detects an Agent tool call without subagent_type and defaults to coder", () => {
    const info = detectKimiSubagentToolCall({
      title: "Launching background coder agent: investigate",
      data: {
        rawInput: {
          description: "investigate",
          prompt: "look into it",
          run_in_background: true,
        },
      },
    });

    expect(info).toEqual({
      kind: "agent",
      subagentType: "coder",
      description: "investigate",
    });
  });

  it("detects the lazy title path (bare Agent title) via rawInput alone", () => {
    const info = detectKimiSubagentToolCall({
      title: "Agent",
      data: {
        rawInput: {
          prompt: "continue the work",
          resume: "agent-1",
          subagent_type: "explore",
        },
      },
    });

    expect(info).toEqual({
      kind: "agent",
      subagentType: "explore",
      description: "Agent",
    });
  });

  it("detects an AgentSwarm tool call", () => {
    const info = detectKimiSubagentToolCall({
      title: "Launching agent swarm: review files",
      data: {
        rawInput: {
          items: ["src/a.ts", "src/b.ts"],
          prompt_template: "Review {{item}} for regressions.",
        },
      },
    });

    expect(info).toEqual({
      kind: "agent_swarm",
      subagentType: "swarm",
      // AgentSwarm rawInput carries no description; fall back to the title.
      description: "Launching agent swarm: review files",
    });
  });

  it("falls back to the title for the description", () => {
    const info = detectKimiSubagentToolCall({
      title: "Launching coder agent: something",
      data: {
        rawInput: {
          description: "   ",
          prompt: "do it",
        },
      },
    });

    expect(info?.description).toBe("Launching coder agent: something");
  });

  it("does not detect on title alone without structural rawInput", () => {
    expect(
      detectKimiSubagentToolCall({
        title: "Launching coder agent: fix the bug",
        data: {},
      }),
    ).toBeUndefined();
    expect(
      detectKimiSubagentToolCall({
        title: "Agent",
        data: { rawInput: "not-an-object" },
      }),
    ).toBeUndefined();
  });

  it("does not detect regular tool calls", () => {
    expect(
      detectKimiSubagentToolCall({
        title: "Terminal",
        data: { rawInput: { command: ["echo", "hello"] } },
      }),
    ).toBeUndefined();
    expect(
      detectKimiSubagentToolCall({
        title: "Read File",
        data: { rawInput: {} },
      }),
    ).toBeUndefined();
    // prompt without description/subagent_type is not an Agent call
    expect(
      detectKimiSubagentToolCall({
        title: "Some tool",
        data: { rawInput: { prompt: "hello" } },
      }),
    ).toBeUndefined();
  });
});

describe("extractSubagentSummary", () => {
  it("extracts a plain string report", () => {
    expect(extractSubagentSummary("  final report  ")).toBe("final report");
  });

  it("extracts from common object shapes", () => {
    expect(extractSubagentSummary({ text: "report text" })).toBe("report text");
    expect(extractSubagentSummary({ report: "report field" })).toBe("report field");
    expect(extractSubagentSummary({ content: "content string" })).toBe("content string");
    expect(
      extractSubagentSummary({
        content: [
          { type: "content", content: { type: "text", text: "block one" } },
          { type: "content", content: { type: "text", text: "block two" } },
        ],
      }),
    ).toBe("block one\nblock two");
  });

  it("returns undefined for empty or unusable output", () => {
    expect(extractSubagentSummary(undefined)).toBeUndefined();
    expect(extractSubagentSummary("   ")).toBeUndefined();
    expect(extractSubagentSummary({})).toBeUndefined();
    expect(extractSubagentSummary(42)).toBeUndefined();
  });

  it("truncates huge reports", () => {
    const huge = "x".repeat(5000);
    const summary = extractSubagentSummary(huge);
    expect(summary).toBe(truncateSubagentSummary(huge));
    expect(summary?.length).toBe(2001);
    expect(summary?.endsWith("…")).toBe(true);
  });
});
