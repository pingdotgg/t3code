import { describe, expect, it } from "vite-plus/test";

import { AGENT_RUN_FEED_CAP, type AgentRun, type AgentRunPhase } from "../../agentRuns.ts";
import {
  AGENT_RUN_CHIP_BUDGET,
  AGENT_RUN_COMPACT_FEED_LINES,
  agentRunChips,
  agentRunStatusAtom,
  formatAgentRunDuration,
  visibleAgentRunFeedLines,
} from "./agentRunPresentation.ts";

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    taskId: "task-1",
    rowId: "a1",
    createdAt: "2026-07-18T00:00:00.000Z",
    settledAt: null,
    turnId: null,
    title: "Agent run",
    phase: "running",
    ambient: false,
    detailsUnavailable: false,
    feed: [],
    ...overrides,
  };
}

describe("agentRunStatusAtom", () => {
  it("maps every phase, treating queued work as running", () => {
    const expected: Record<AgentRunPhase, string> = {
      running: "spinner",
      done: "check",
      failed: "cross",
      stopped: "square",
    };
    for (const [phase, atom] of Object.entries(expected)) {
      expect(agentRunStatusAtom(phase as AgentRunPhase)).toBe(atom);
    }
  });
});

describe("agentRunChips", () => {
  it("never exceeds the chip budget", () => {
    const chips = agentRunChips(
      run({
        phase: "failed",
        subagentType: "code-reviewer",
        toolUses: 4,
        totalTokens: 12_400,
      }),
    );
    expect(chips).toHaveLength(AGENT_RUN_CHIP_BUDGET);
    expect(chips.map((chip) => chip.id)).toEqual(["failed", "subagent", "tools"]);
  });

  it("drops the subagent chip when the title already says it", () => {
    const chips = agentRunChips(run({ title: "code-reviewer", subagentType: "code-reviewer" }));
    expect(chips.map((chip) => chip.id)).toEqual([]);
  });

  it("formats metric chips", () => {
    expect(agentRunChips(run({ toolUses: 1, totalTokens: 900 })).map((chip) => chip.label)).toEqual(
      ["1 tool", "900 tokens"],
    );
    expect(agentRunChips(run({ totalTokens: 12_400 })).map((chip) => chip.label)).toEqual([
      "12k tokens",
    ]);
  });

  it("omits zero metrics", () => {
    expect(agentRunChips(run({ toolUses: 0, totalTokens: 0 }))).toEqual([]);
  });
});

describe("formatAgentRunDuration", () => {
  it("formats the units the card shows", () => {
    expect(formatAgentRunDuration(900)).toBe("1s");
    expect(formatAgentRunDuration(59_000)).toBe("59s");
    expect(formatAgentRunDuration(120_000)).toBe("2m");
    expect(formatAgentRunDuration(125_000)).toBe("2m 5s");
    expect(formatAgentRunDuration(7_260_000)).toBe("2h 1m");
  });

  it("returns null for missing or nonsensical durations", () => {
    expect(formatAgentRunDuration(undefined)).toBe(null);
    expect(formatAgentRunDuration(-1)).toBe(null);
    expect(formatAgentRunDuration(Number.NaN)).toBe(null);
  });
});

describe("visibleAgentRunFeedLines", () => {
  const feed = Array.from({ length: AGENT_RUN_FEED_CAP }, (_, index) => `line-${index}`);

  it("shows the whole feed at full density", () => {
    expect(visibleAgentRunFeedLines(feed, "full")).toEqual(feed);
  });

  it("shows only the newest lines in the tracker popover", () => {
    const compact = visibleAgentRunFeedLines(feed, "compact");
    expect(compact).toHaveLength(AGENT_RUN_COMPACT_FEED_LINES);
    expect(compact.at(-1)).toBe(feed.at(-1));
  });

  it("leaves a short feed untouched", () => {
    expect(visibleAgentRunFeedLines(["only"], "compact")).toEqual(["only"]);
  });
});
