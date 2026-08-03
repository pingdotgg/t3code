import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_RUN_FEED_CAP,
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
    expect(feed[0]?.label).toBe("step 12");
    expect(feed.at(-1)?.label).toBe(`step ${AGENT_RUN_FEED_CAP + 11}`);
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
    expect(runs[0]?.feed.map((line) => line.label)).toEqual(["one-step"]);
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
        // Blank label: no feed line is pushed, so the run itself is unchanged —
        // but the activity is consumed and must not stay in the transcript.
        activity({
          id: "p2",
          kind: "task.progress",
          payload: { taskId: "task-1", lastToolName: "Read" },
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
