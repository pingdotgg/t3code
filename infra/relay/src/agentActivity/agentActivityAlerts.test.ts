import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityAggregateState,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import { islandSummaryChanged } from "./agentActivityAlerts.ts";

const row = (
  threadId: string,
  phase: RelayAgentActivityAggregateRow["phase"],
  status = "Working",
): RelayAgentActivityAggregateRow => ({
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make(threadId),
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "gpt-5.4",
  phase,
  status,
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/",
});

const aggregate = (
  activeCount: number,
  activities: ReadonlyArray<RelayAgentActivityAggregateRow>,
): RelayAgentActivityAggregateState => ({
  title: "T3 Code",
  subtitle: "Agent work in progress",
  activeCount,
  updatedAt: "1970-01-01T00:00:00.000Z",
  activities: [...activities],
});

describe("islandSummaryChanged", () => {
  it("treats the first aggregate as a change", () => {
    expect(islandSummaryChanged(null, aggregate(1, [row("a", "running")]))).toBe(true);
  });

  it("ignores status text and the starting to running step", () => {
    const starting = aggregate(1, [row("a", "starting", "Starting")]);
    const running = aggregate(1, [row("a", "running", "Reading files")]);
    const stillRunning = aggregate(1, [row("a", "running", "Editing files")]);
    expect(islandSummaryChanged(starting, running)).toBe(false);
    expect(islandSummaryChanged(running, stillRunning)).toBe(false);
    const finishedFirst = aggregate(1, [row("b", "completed"), row("a", "running")]);
    expect(islandSummaryChanged(running, finishedFirst)).toBe(false);
  });

  it("flags the only working row going stale", () => {
    const running = aggregate(1, [row("a", "running")]);
    expect(islandSummaryChanged(running, aggregate(1, [row("a", "stale", "Waiting")]))).toBe(true);
  });

  it("flags attention, failure and completion of all work", () => {
    const running = aggregate(1, [row("a", "running")]);
    expect(islandSummaryChanged(running, aggregate(1, [row("a", "waiting_for_input")]))).toBe(true);
    expect(
      islandSummaryChanged(running, aggregate(1, [row("b", "running"), row("a", "failed")])),
    ).toBe(true);
    expect(islandSummaryChanged(running, aggregate(0, [row("a", "completed")]))).toBe(true);
  });

  it("flags work starting after everything was done", () => {
    const done = aggregate(0, [row("a", "completed")]);
    expect(islandSummaryChanged(done, aggregate(1, [row("b", "starting")]))).toBe(true);
  });
});
