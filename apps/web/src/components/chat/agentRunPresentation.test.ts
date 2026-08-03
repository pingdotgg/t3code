import { describe, expect, it } from "vite-plus/test";

import { AGENT_RUN_FEED_CAP, type AgentRun, type AgentRunPhase } from "../../agentRuns.ts";
import {
  AGENT_RUN_CHIP_BUDGET,
  AGENT_RUN_COMPACT_CHIP_BUDGET,
  AGENT_RUN_FEED_PREVIEW_LINES,
  agentRunChips,
  agentRunElapsedLabel,
  agentRunFeedLineTooltip,
  agentRunFeedRepeatLabel,
  agentRunFeedShowAllLabel,
  agentRunStatusAtom,
  agentRunStatusLabel,
  agentRunStopAllButtonLabel,
  agentRunStopAllTooltip,
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

  // D5 — the card lives in a resizable pane and a 352px popover, both of which
  // satisfy every *viewport* breakpoint, so the old `sm:` gate never fired.
  it("gates each chip on the card's own width, cheapest signal first", () => {
    const chips = agentRunChips(
      run({ subagentType: "code-reviewer", toolUses: 6, totalTokens: 26_000 }),
    );
    expect(chips.map((chip) => [chip.id, chip.gateClassName])).toEqual([
      ["subagent", "hidden @[18rem]/agent-run:inline-flex"],
      ["tools", "hidden @[22rem]/agent-run:inline-flex"],
      ["tokens", "hidden @[26rem]/agent-run:inline-flex"],
    ]);
  });

  it("never gates the failure chip", () => {
    const chips = agentRunChips(run({ phase: "failed", toolUses: 6 }));
    expect(chips[0]?.id).toBe("failed");
    expect(chips[0]?.gateClassName).toBe("");
  });

  it("carries a smaller budget in the tracker popover", () => {
    const compact = agentRunChips(
      run({ phase: "failed", subagentType: "code-reviewer", toolUses: 6, totalTokens: 26_000 }),
      "compact",
    );
    expect(compact).toHaveLength(AGENT_RUN_COMPACT_CHIP_BUDGET);
    expect(compact.map((chip) => chip.id)).toEqual(["failed", "subagent"]);
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

  it("previews the newest lines at each density", () => {
    expect(visibleAgentRunFeedLines(feed, "full")).toHaveLength(AGENT_RUN_FEED_PREVIEW_LINES.full);
    expect(visibleAgentRunFeedLines(feed, "compact")).toHaveLength(
      AGENT_RUN_FEED_PREVIEW_LINES.compact,
    );
    expect(visibleAgentRunFeedLines(feed, "compact").at(-1)).toBe(feed.at(-1));
  });

  it("shows everything once the row asked for it", () => {
    expect(visibleAgentRunFeedLines(feed, "full", true)).toEqual(feed);
    expect(visibleAgentRunFeedLines(feed, "compact", true)).toEqual(feed);
  });

  it("leaves a short feed untouched", () => {
    expect(visibleAgentRunFeedLines(["only"], "compact")).toEqual(["only"]);
  });

  it("offers 'Show all' only when something is hidden", () => {
    expect(agentRunFeedShowAllLabel(feed.length, "full")).toBe(`Show all ${feed.length} steps`);
    expect(agentRunFeedShowAllLabel(AGENT_RUN_FEED_PREVIEW_LINES.full, "full")).toBe(null);
    expect(agentRunFeedShowAllLabel(4, "compact")).toBe("Show all 4 steps");
  });
});

describe("feed line copy", () => {
  const line = {
    id: "p1",
    createdAt: "2026-07-18T00:00:01.000Z",
    updatedAt: "2026-07-18T00:00:01.000Z",
    kind: "tool" as const,
    text: "Idle 30 seconds",
    tool: "Bash",
    repeat: 1,
  };

  it("marks a coalesced line and nothing else", () => {
    expect(agentRunFeedRepeatLabel(1)).toBe(null);
    expect(agentRunFeedRepeatLabel(3)).toBe("×3");
  });

  it("hands the tooltip the whole line, actor included", () => {
    expect(agentRunFeedLineTooltip(line)).toBe("Bash · Idle 30 seconds");
    const { tool: _tool, ...toolless } = line;
    expect(agentRunFeedLineTooltip(toolless)).toBe("Idle 30 seconds");
  });

  it("has nothing to recover for an actor-only line", () => {
    expect(agentRunFeedLineTooltip({ ...line, text: "" })).toBe(null);
  });
});

describe("agentRunStatusLabel", () => {
  it("is the single vocabulary for every surface", () => {
    expect(agentRunStatusLabel("running")).toBe("Running");
    expect(agentRunStatusLabel("queued")).toBe("Queued");
    expect(agentRunStatusLabel("stopping")).toBe("Stopping…");
    expect(agentRunStatusLabel("stopped")).toBe("Stopped");
    expect(agentRunStatusLabel("done")).toBe("Completed");
    expect(agentRunStatusLabel("failed")).toBe("Failed");
  });
});

describe("agentRunElapsedLabel", () => {
  it("gives the running slot to the card's own ticker", () => {
    expect(
      agentRunElapsedLabel({ phase: "running", durationMs: undefined, stopPending: false }),
    ).toBe(null);
  });

  it("a requested stop outranks the clock, in both densities", () => {
    expect(agentRunElapsedLabel({ phase: "running", durationMs: 1000, stopPending: true })).toBe(
      "Stopping…",
    );
  });

  it("falls back to the status word when a settled run has no duration", () => {
    expect(
      agentRunElapsedLabel({ phase: "stopped", durationMs: undefined, stopPending: false }),
    ).toBe("Stopped");
    expect(agentRunElapsedLabel({ phase: "done", durationMs: 4000, stopPending: false })).toBe(
      "4s",
    );
  });
});

describe("agentRunStopAll copy", () => {
  it("keeps both press labels short enough for one fixed slot", () => {
    expect(agentRunStopAllButtonLabel(false)).toBe("Stop all");
    expect(agentRunStopAllButtonLabel(true)).toBe("Confirm");
  });

  it("moves the count into the tooltip, where it cannot move the target", () => {
    expect(agentRunStopAllTooltip(3, false)).toBe("Stop 3 runs");
    expect(agentRunStopAllTooltip(3, true)).toBe("Press again to stop 3 runs");
    expect(agentRunStopAllTooltip(1, true)).toBe("Press again to stop 1 run");
  });
});
