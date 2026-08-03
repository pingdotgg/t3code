import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_RUN_FEED_CAP,
  agentRunFeedActor,
  agentRunFeedText,
  agentRunFeedWith,
  deriveAgentRuns,
  stabilizeAgentRuns,
  withAgentRunEntries,
} from "./agentRuns.ts";
import type { TimelineEntry, WorkLogEntry } from "./session-logic.ts";

const TURN = TurnId.make("turn-1");
const OTHER_TURN = TurnId.make("turn-0");

let clock = 0;
function nextIso(): string {
  clock += 1000;
  return new Date(Date.UTC(2026, 6, 18, 0, 0, 0) + clock).toISOString();
}

function activity(input: {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly summary?: string;
  readonly turnId?: TurnId | null;
  readonly createdAt?: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    tone: "info",
    kind: input.kind,
    summary: input.summary ?? "Task update",
    payload: input.payload,
    turnId: input.turnId === undefined ? TURN : input.turnId,
    createdAt: input.createdAt ?? nextIso(),
  };
}

function workEntry(id: string, createdAt: string): TimelineEntry {
  const entry: WorkLogEntry = { id, createdAt, label: "row", tone: "info" };
  return { id, kind: "work", createdAt, entry };
}

describe("deriveAgentRuns", () => {
  it("groups every task activity for one taskId into a single run", () => {
    const started = activity({
      id: "a1",
      kind: "task.started",
      payload: {
        taskId: "task-1",
        detail: "Review the migration",
        subagentType: "code-reviewer",
        taskType: "local_agent",
        prompt: "Please review.",
        toolUseId: "toolu_1",
      },
    });
    const progress = activity({
      id: "a2",
      kind: "task.progress",
      payload: { taskId: "task-1", title: "Reading files", lastToolName: "Read", toolUses: 3 },
    });
    const completed = activity({
      id: "a3",
      kind: "task.completed",
      payload: { taskId: "task-1", status: "completed", summary: "Reviewed 4 files" },
    });

    const { runs, consumedActivityIds } = deriveAgentRuns([started, progress, completed], {
      activeTurnId: TURN,
    });

    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run?.taskId).toBe("task-1");
    expect(run?.rowId).toBe("a1");
    expect(run?.phase).toBe("done");
    expect(run?.title).toBe("code-reviewer");
    expect(run?.summary).toBe("Reviewed 4 files");
    expect(run?.prompt).toBe("Please review.");
    expect(run?.toolUses).toBe(3);
    expect(run?.detailsUnavailable).toBe(false);
    expect([...consumedActivityIds].toSorted()).toEqual(["a1", "a2", "a3"]);
  });

  it("terminal phase is sticky", () => {
    const activities = [
      activity({ id: "a1", kind: "task.started", payload: { taskId: "t", detail: "Work" } }),
      activity({
        id: "a2",
        kind: "task.completed",
        payload: { taskId: "t", status: "failed", error: "boom" },
      }),
      activity({ id: "a3", kind: "task.progress", payload: { taskId: "t", title: "still busy" } }),
      activity({ id: "a4", kind: "task.completed", payload: { taskId: "t", status: "completed" } }),
    ];

    const { runs } = deriveAgentRuns(activities, { activeTurnId: TURN });
    expect(runs[0]?.phase).toBe("failed");
    expect(runs[0]?.error).toBe("boom");
  });

  it("unknown status is failed, never done", () => {
    for (const status of ["succeeded", "", undefined, null, 7]) {
      const { runs } = deriveAgentRuns(
        [
          activity({ id: "a1", kind: "task.started", payload: { taskId: "t", detail: "Work" } }),
          activity({ id: "a2", kind: "task.completed", payload: { taskId: "t", status } }),
        ],
        { activeTurnId: TURN },
      );
      expect(runs[0]?.phase).toBe("failed");
    }
  });

  it("caps the feed at 20 lines, newest kept", () => {
    const activities: OrchestrationThreadActivity[] = [
      activity({ id: "a0", kind: "task.started", payload: { taskId: "t", detail: "Work" } }),
    ];
    for (let index = 0; index < AGENT_RUN_FEED_CAP + 12; index += 1) {
      activities.push(
        activity({
          id: `p${index}`,
          kind: "task.progress",
          payload: { taskId: "t", title: `step ${index}` },
        }),
      );
    }

    const { runs } = deriveAgentRuns(activities, { activeTurnId: TURN });
    const feed = runs[0]?.feed ?? [];
    expect(feed).toHaveLength(AGENT_RUN_FEED_CAP);
    expect(feed[0]?.text).toBe("step 12");
    expect(feed.at(-1)?.text).toBe(`step ${AGENT_RUN_FEED_CAP + 11}`);
  });

  it("runs with no task.started still render", () => {
    const { runs } = deriveAgentRuns(
      [
        activity({
          id: "a2",
          kind: "task.progress",
          payload: { taskId: "t", title: "Restored work" },
        }),
        activity({ id: "a3", kind: "task.completed", payload: { taskId: "t", status: "stopped" } }),
      ],
      { activeTurnId: TURN },
    );

    expect(runs).toHaveLength(1);
    expect(runs[0]?.detailsUnavailable).toBe(true);
    expect(runs[0]?.rowId).toBe("a2");
    expect(runs[0]?.phase).toBe("stopped");
    expect(runs[0]?.title).toBe("Restored work");
  });

  it("stale runs settle to stopped", () => {
    const { runs } = deriveAgentRuns(
      [
        activity({
          id: "a1",
          kind: "task.started",
          payload: { taskId: "t", detail: "Work" },
          turnId: OTHER_TURN,
        }),
      ],
      { activeTurnId: TURN },
    );
    expect(runs[0]?.phase).toBe("stopped");

    const { runs: liveRuns } = deriveAgentRuns(
      [
        activity({
          id: "a1",
          kind: "task.started",
          payload: { taskId: "t", detail: "Work" },
          turnId: TURN,
        }),
      ],
      { activeTurnId: TURN },
    );
    expect(liveRuns[0]?.phase).toBe("running");
  });

  it("keeps two interleaved taskIds apart", () => {
    const { runs } = deriveAgentRuns(
      [
        activity({ id: "a1", kind: "task.started", payload: { taskId: "t1", detail: "One" } }),
        activity({ id: "a2", kind: "task.started", payload: { taskId: "t2", detail: "Two" } }),
        activity({ id: "a3", kind: "task.progress", payload: { taskId: "t1", title: "one-step" } }),
        activity({ id: "a4", kind: "task.completed", payload: { taskId: "t2", status: "failed" } }),
      ],
      { activeTurnId: TURN },
    );

    expect(runs.map((run) => run.taskId)).toEqual(["t1", "t2"]);
    expect(runs[0]?.phase).toBe("running");
    expect(runs[1]?.phase).toBe("failed");
    expect(runs[0]?.feed.map((line) => line.text)).toEqual(["one-step"]);
  });

  it("ignores a malformed payload instead of throwing", () => {
    expect(() =>
      deriveAgentRuns(
        [
          activity({ id: "a1", kind: "task.started", payload: "not an object" }),
          activity({ id: "a2", kind: "task.progress", payload: null }),
          activity({ id: "a3", kind: "task.completed", payload: { taskId: 7 } }),
        ],
        { activeTurnId: TURN },
      ),
    ).not.toThrow();

    const { runs, consumedActivityIds } = deriveAgentRuns(
      [activity({ id: "a1", kind: "task.started", payload: "not an object" })],
      { activeTurnId: TURN },
    );
    expect(runs).toHaveLength(0);
    expect(consumedActivityIds.size).toBe(0);
  });
});

describe("withAgentRunEntries", () => {
  it("replaces every consumed work row with one agent-run row at that position", () => {
    const started = activity({
      id: "a1",
      kind: "task.started",
      payload: { taskId: "t", detail: "Work" },
    });
    const progress = activity({ id: "a2", kind: "task.progress", payload: { taskId: "t" } });
    const completed = activity({
      id: "a3",
      kind: "task.completed",
      payload: { taskId: "t", status: "completed" },
    });
    const unrelated = workEntry("other", nextIso());

    const entries: TimelineEntry[] = [
      workEntry("a2", progress.createdAt),
      workEntry("a3", completed.createdAt),
      unrelated,
    ];

    const rows = withAgentRunEntries(entries, [started, progress, completed], {
      activeTurnId: TURN,
    });

    expect(rows.map((row) => row.kind)).toEqual(["agent-run", "work"]);
    expect(rows[0]?.id).toBe("agent-run:a1");
    expect(rows[1]?.id).toBe("other");
  });

  it("drops ambient runs from the transcript, including their work rows", () => {
    const started = activity({
      id: "a1",
      kind: "task.started",
      payload: { taskId: "t", detail: "Housekeeping", ambient: true },
    });
    const completed = activity({
      id: "a2",
      kind: "task.completed",
      payload: { taskId: "t", status: "completed" },
    });

    const rows = withAgentRunEntries([workEntry("a2", completed.createdAt)], [started, completed], {
      activeTurnId: TURN,
    });
    expect(rows).toHaveLength(0);

    const { runs } = deriveAgentRuns([started, completed], { activeTurnId: TURN });
    expect(runs[0]?.ambient).toBe(true);
  });

  it("returns the entries untouched when no task activity is present", () => {
    const entries = [workEntry("w1", nextIso())];
    expect(withAgentRunEntries(entries, [], { activeTurnId: TURN })).toEqual(entries);
  });

  it("keeps a stable row id across re-derivations", () => {
    const started = activity({
      id: "a1",
      kind: "task.started",
      payload: { taskId: "t", detail: "Work" },
    });
    const progress = activity({ id: "a2", kind: "task.progress", payload: { taskId: "t" } });

    const first = withAgentRunEntries([workEntry("a2", progress.createdAt)], [started], {
      activeTurnId: TURN,
    });
    const second = withAgentRunEntries([workEntry("a2", progress.createdAt)], [started, progress], {
      activeTurnId: TURN,
    });

    expect(first[0]?.id).toBe(second[0]?.id);
  });
});

describe("stabilizeAgentRuns", () => {
  const activities = [
    activity({
      id: "s1",
      kind: "task.started",
      payload: { taskId: "task-1", detail: "Reviewing" },
      createdAt: "2026-07-18T00:00:01.000Z",
    }),
    activity({
      id: "p1",
      kind: "task.progress",
      payload: { taskId: "task-1", title: "Reading files", lastToolName: "Read" },
      createdAt: "2026-07-18T00:00:02.000Z",
    }),
  ];

  it("returns the previous result verbatim when a re-derivation changed nothing", () => {
    const first = deriveAgentRuns(activities, { activeTurnId: TURN });
    const second = deriveAgentRuns(activities, { activeTurnId: TURN });
    expect(second).not.toBe(first);
    expect(stabilizeAgentRuns(first, second)).toBe(first);
  });

  it("keeps the identity of runs that did not change while a new run lands", () => {
    const first = deriveAgentRuns(activities, { activeTurnId: TURN });
    const second = deriveAgentRuns(
      [
        ...activities,
        activity({
          id: "s2",
          kind: "task.started",
          payload: { taskId: "task-2", detail: "Second" },
          createdAt: "2026-07-18T00:00:03.000Z",
        }),
      ],
      { activeTurnId: TURN },
    );
    const stabilized = stabilizeAgentRuns(first, second);
    expect(stabilized).not.toBe(first);
    expect(stabilized.runs[0]).toBe(first.runs[0]);
    expect(stabilized.runs[1]?.taskId).toBe("task-2");
  });

  it("replaces a run object once its content moves on", () => {
    const first = deriveAgentRuns(activities, { activeTurnId: TURN });
    const second = deriveAgentRuns(
      [
        ...activities,
        activity({
          id: "c1",
          kind: "task.completed",
          payload: { taskId: "task-1", status: "completed", summary: "Done" },
          createdAt: "2026-07-18T00:00:04.000Z",
        }),
      ],
      { activeTurnId: TURN },
    );
    const stabilized = stabilizeAgentRuns(first, second);
    expect(stabilized.runs[0]).not.toBe(first.runs[0]);
    expect(stabilized.runs[0]?.phase).toBe("done");
  });

  it("takes the fresh result when a consumed activity landed without altering a run", () => {
    const first = deriveAgentRuns(activities, { activeTurnId: TURN });
    const second = deriveAgentRuns(
      [
        ...activities,
        // Blank label and no actor: no feed line is pushed, so the run itself
        // is unchanged — but the activity is consumed and must not stay in the
        // transcript.
        activity({
          id: "p2",
          kind: "task.progress",
          payload: { taskId: "task-1" },
          summary: "   ",
          createdAt: "2026-07-18T00:00:05.000Z",
        }),
      ],
      { activeTurnId: TURN },
    );
    const stabilized = stabilizeAgentRuns(first, second);
    expect(stabilized).not.toBe(first);
    expect(stabilized.consumedActivityIds.has("p2")).toBe(true);
    expect(stabilized.runs[0]).toBe(first.runs[0]);
  });
});

// F-26 — change detection compared `consumedActivityIds.size`, not contents.
// Two derivations with the same count but different ids returned `previous`,
// so the timeline kept hiding the wrong work rows.
describe("stabilizeAgentRuns consumedActivityIds (F-26)", () => {
  const runs = [
    {
      taskId: "task-1",
      rowId: "row-1",
      createdAt: "2026-07-18T00:00:00.000Z",
      settledAt: null,
      turnId: null,
      title: "Agent run",
      phase: "running" as const,
      ambient: false,
      detailsUnavailable: false,
      feed: [],
    },
  ];

  it("takes the new result when the id SET changed but its size did not", () => {
    const first = { runs, consumedActivityIds: new Set(["a"]) };
    const second = { runs: [...runs], consumedActivityIds: new Set(["b"]) };
    const stabilized = stabilizeAgentRuns(first, second);
    expect(stabilized).not.toBe(first);
    expect(stabilized.consumedActivityIds.has("b")).toBe(true);
    expect(stabilized.consumedActivityIds.has("a")).toBe(false);
  });

  it("still returns the previous result when both the runs and the id set match", () => {
    const first = { runs, consumedActivityIds: new Set(["a", "b"]) };
    const second = { runs: [...runs], consumedActivityIds: new Set(["b", "a"]) };
    expect(stabilizeAgentRuns(first, second)).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// D1 — the title is frozen at `task.started`.
// The reported screenshot showed a run named "Idle 20 seconds": a Bash progress
// description standing in as the run's identity, rewritten on every frame.
// ---------------------------------------------------------------------------

describe("agent-run title (D1)", () => {
  function titleOf(started: unknown, ...progress: ReadonlyArray<unknown>): string | undefined {
    const activities = [
      activity({ id: "a1", kind: "task.started", payload: started }),
      ...progress.map((payload, index) =>
        activity({ id: `p${index}`, kind: "task.progress", payload }),
      ),
    ];
    return deriveAgentRuns(activities, { activeTurnId: TURN }).runs[0]?.title;
  }

  it("never lets a progress frame rename a started run", () => {
    expect(
      titleOf(
        { taskId: "t", detail: "Review the migration" },
        { taskId: "t", title: "Idle 30 seconds", lastToolName: "Bash" },
        { taskId: "t", title: "Idle 20 seconds", lastToolName: "Bash" },
      ),
    ).toBe("Review the migration");
  });

  it("orders workflow → subagent → start detail → task type → prompt", () => {
    expect(
      titleOf({ taskId: "t", workflowName: "ship-it", subagentType: "reviewer", detail: "d" }),
    ).toBe("ship-it");
    expect(titleOf({ taskId: "t", subagentType: "reviewer", detail: "d", taskType: "local" })).toBe(
      "reviewer",
    );
    expect(titleOf({ taskId: "t", detail: "Review the migration", taskType: "local_agent" })).toBe(
      "Review the migration",
    );
    expect(titleOf({ taskId: "t", taskType: "local_agent", prompt: "Look at the tests" })).toBe(
      "local_agent",
    );
    expect(
      titleOf({ taskId: "t", prompt: "Please look at the failing snapshot tests today" }),
    ).toBe("Please look at the failing snapshot…");
  });

  it("falls back to a generic name rather than a tool name", () => {
    expect(titleOf({ taskId: "t" }, { taskId: "t", lastToolName: "Bash", title: "Idle" })).toBe(
      "Agent run",
    );
  });

  it("names a restored run from its first progress frame, then freezes that too", () => {
    const { runs } = deriveAgentRuns(
      [
        activity({ id: "p1", kind: "task.progress", payload: { taskId: "t", title: "Restored" } }),
        activity({ id: "p2", kind: "task.progress", payload: { taskId: "t", title: "Later" } }),
      ],
      { activeTurnId: TURN },
    );
    expect(runs[0]?.title).toBe("Restored");
    expect(runs[0]?.detailsUnavailable).toBe(true);
  });

  it("keeps the title when the run completes", () => {
    const { runs } = deriveAgentRuns(
      [
        activity({ id: "a1", kind: "task.started", payload: { taskId: "t", detail: "Migrate" } }),
        activity({
          id: "c1",
          kind: "task.completed",
          payload: { taskId: "t", status: "completed", summary: "Rewrote 12 files" },
        }),
      ],
      { activeTurnId: TURN },
    );
    expect(runs[0]?.title).toBe("Migrate");
    expect(runs[0]?.summary).toBe("Rewrote 12 files");
  });
});

// ---------------------------------------------------------------------------
// D2/D3/D4 — the feed. Every case below is a line the screenshot actually
// rendered: duplicated rows, "Bash Running Idle 30 seconds", and three nested
// agents repeating the parent's prompt.
// ---------------------------------------------------------------------------

describe("agentRunFeedText (D3)", () => {
  it("drops the actor and the bare status verb the row already shows", () => {
    expect(agentRunFeedText("Running Idle 30 seconds", "Bash")).toBe("Idle 30 seconds");
    expect(agentRunFeedText("Bash Running Idle 30 seconds", "Bash")).toBe("Idle 30 seconds");
    expect(agentRunFeedText("Bash", "Bash")).toBe("");
    expect(agentRunFeedText("Reading files", "Read")).toBe("files");
  });

  it("keeps a sentence that is not repeating its actor", () => {
    expect(agentRunFeedText("Two-phase smoke test", "synthesize")).toBe("Two-phase smoke test");
    expect(agentRunFeedText("Searching for TODOs", "Grep")).toBe("Searching for TODOs");
  });

  it("leaves the text alone when there is no actor", () => {
    expect(agentRunFeedText("Running Idle 30 seconds", undefined)).toBe("Running Idle 30 seconds");
    expect(agentRunFeedText(null, "Bash")).toBe("");
  });
});

describe("agentRunFeedActor (D4)", () => {
  it("reads a nested agent out of the tool-name slot and drops its elapsed", () => {
    expect(agentRunFeedActor("probe:toolchain(65s)")).toEqual({
      kind: "subagent",
      tool: "probe:toolchain",
    });
    expect(agentRunFeedActor("synthesize(20s)")).toEqual({ kind: "subagent", tool: "synthesize" });
  });

  it("treats everything else as a tool", () => {
    expect(agentRunFeedActor("Bash")).toEqual({ kind: "tool", tool: "Bash" });
    expect(agentRunFeedActor("mcp__x__do(thing)")).toEqual({
      kind: "tool",
      tool: "mcp__x__do(thing)",
    });
    expect(agentRunFeedActor(null)).toBe(null);
    expect(agentRunFeedActor("   ")).toBe(null);
  });
});

describe("agentRunFeedWith (D2)", () => {
  const base = { id: "p1", createdAt: "2026-07-18T00:00:01.000Z", kind: "tool" as const };

  it("coalesces a repeated line instead of appending it", () => {
    let feed = agentRunFeedWith([], { ...base, tool: "Bash", text: "Idle 30 seconds" });
    feed = agentRunFeedWith(feed, {
      ...base,
      id: "p2",
      createdAt: "2026-07-18T00:00:02.000Z",
      tool: "Bash",
      text: "Idle 30 seconds",
    });
    expect(feed).toHaveLength(1);
    expect(feed[0]?.repeat).toBe(2);
    expect(feed[0]?.id).toBe("p1");
    expect(feed[0]?.updatedAt).toBe("2026-07-18T00:00:02.000Z");
  });

  it("replaces the tail in place when the same activity progresses", () => {
    let feed = agentRunFeedWith([], {
      ...base,
      tool: "Bash",
      text: "Idle 30 seconds",
      toolUseId: "toolu_1",
    });
    feed = agentRunFeedWith(feed, {
      ...base,
      id: "p2",
      tool: "Bash",
      text: "Idle 20 seconds",
      toolUseId: "toolu_1",
    });
    expect(feed).toHaveLength(1);
    expect(feed[0]?.text).toBe("Idle 20 seconds");
    expect(feed[0]?.repeat).toBe(1);
    expect(feed[0]?.id).toBe("p1");
  });

  it("appends a genuinely different line and keeps the cap", () => {
    let feed = agentRunFeedWith([], { ...base, tool: "Bash", text: "one" });
    feed = agentRunFeedWith(feed, { ...base, id: "p2", tool: "Read", text: "two" });
    expect(feed.map((line) => line.text)).toEqual(["one", "two"]);

    for (let index = 0; index < AGENT_RUN_FEED_CAP + 5; index += 1) {
      feed = agentRunFeedWith(feed, { ...base, id: `x${index}`, tool: "Bash", text: `n${index}` });
    }
    expect(feed).toHaveLength(AGENT_RUN_FEED_CAP);
  });

  it("ignores a frame with neither an actor nor text", () => {
    const feed = agentRunFeedWith([], { ...base, text: "" });
    expect(feed).toEqual([]);
  });

  it("keeps a tool-only line: the actor alone is information", () => {
    const feed = agentRunFeedWith([], { ...base, tool: "Bash", text: "" });
    expect(feed).toHaveLength(1);
    expect(feed[0]?.tool).toBe("Bash");
  });
});

describe("feed coalescing through deriveAgentRuns (the reported screenshot)", () => {
  it("collapses repeated Bash status frames into one line with a repeat count", () => {
    const { runs } = deriveAgentRuns(
      [
        activity({ id: "a1", kind: "task.started", payload: { taskId: "t", detail: "general" } }),
        activity({
          id: "p1",
          kind: "task.progress",
          payload: { taskId: "t", summary: "Running Idle 30 seconds", lastToolName: "Bash" },
        }),
        activity({
          id: "p2",
          kind: "task.progress",
          payload: { taskId: "t", summary: "Running Idle 30 seconds", lastToolName: "Bash" },
        }),
        activity({
          id: "p3",
          kind: "task.progress",
          payload: {
            taskId: "t",
            summary: "Running Show last three commits",
            lastToolName: "Bash",
          },
        }),
      ],
      { activeTurnId: TURN },
    );

    const feed = runs[0]?.feed ?? [];
    expect(feed.map((line) => [line.tool, line.text, line.repeat])).toEqual([
      ["Bash", "Idle 30 seconds", 2],
      ["Bash", "Show last three commits", 1],
    ]);
  });

  it("renders nested agents as subagents and drops the echoed parent prompt", () => {
    const { runs } = deriveAgentRuns(
      [
        activity({
          id: "a1",
          kind: "task.started",
          payload: {
            taskId: "t",
            detail: "test-workflow",
            prompt: "Two-phase smoke test with detailed output",
          },
        }),
        activity({
          id: "p1",
          kind: "task.progress",
          payload: {
            taskId: "t",
            summary: "Two-phase smoke test with detailed output",
            lastToolName: "probe:toolchain(65s)",
          },
        }),
        activity({
          id: "p2",
          kind: "task.progress",
          payload: {
            taskId: "t",
            summary: "Two-phase smoke test with detailed output",
            lastToolName: "synthesize(20s)",
          },
        }),
        activity({
          id: "p3",
          kind: "task.progress",
          payload: {
            taskId: "t",
            summary: "Two-phase smoke test with detailed output",
            lastToolName: "synthesize(24s)",
          },
        }),
      ],
      { activeTurnId: TURN },
    );

    const feed = runs[0]?.feed ?? [];
    expect(feed.map((line) => [line.kind, line.tool, line.text, line.repeat])).toEqual([
      ["subagent", "probe:toolchain", "", 1],
      ["subagent", "synthesize", "", 2],
    ]);
  });

  it("keeps a nested agent's own description when it is not the parent's prompt", () => {
    const { runs } = deriveAgentRuns(
      [
        activity({
          id: "a1",
          kind: "task.started",
          payload: { taskId: "t", prompt: "Parent job" },
        }),
        activity({
          id: "p1",
          kind: "task.progress",
          payload: { taskId: "t", summary: "Checking the lockfile", lastToolName: "probe(3s)" },
        }),
      ],
      { activeTurnId: TURN },
    );
    expect(runs[0]?.feed[0]?.text).toBe("Checking the lockfile");
  });

  it("re-derives to an equal-but-updated run so the visible repeat count moves", () => {
    const frames = [
      activity({
        id: "a1",
        kind: "task.started",
        payload: { taskId: "t", detail: "general" },
        createdAt: "2026-07-18T00:00:01.000Z",
      }),
      activity({
        id: "p1",
        kind: "task.progress",
        payload: { taskId: "t", summary: "Running Idle 30 seconds", lastToolName: "Bash" },
        createdAt: "2026-07-18T00:00:02.000Z",
      }),
    ];
    const first = deriveAgentRuns(frames, { activeTurnId: TURN });
    const second = deriveAgentRuns(
      [
        ...frames,
        activity({
          id: "p2",
          kind: "task.progress",
          payload: { taskId: "t", summary: "Running Idle 30 seconds", lastToolName: "Bash" },
          createdAt: "2026-07-18T00:00:03.000Z",
        }),
      ],
      { activeTurnId: TURN },
    );

    const stabilized = stabilizeAgentRuns(first, second);
    expect(stabilized.runs[0]).not.toBe(first.runs[0]);
    expect(stabilized.runs[0]?.feed[0]?.repeat).toBe(2);
  });
});
