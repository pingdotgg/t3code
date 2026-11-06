import { expect, it } from "@effect/vitest";

import { parsePiAsyncSubagentSnapshot } from "./asyncSubagents.ts";

const snapshotLine = (runs: ReadonlyArray<unknown>) =>
  `PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt: 1_000,
    caps: {},
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs,
  })}`;

it("reads workflow lanes as subagents and ends unstarted lanes with a stopped run", () => {
  expect(
    parsePiAsyncSubagentSnapshot([
      snapshotLine([
        {
          id: "run-1",
          kind: "workflow",
          label: "reviewer, reviewer",
          state: "running",
          children: [
            {
              id: "task-1",
              kind: "step",
              label: "task-1",
              state: "running",
              startedAt: 10,
              agent: "reviewer",
              model: "anthropic/claude-opus-5-5",
              activity: { currentTool: "bash", toolCount: 4 },
            },
            { id: "task-2", kind: "step", label: "task-2", state: "queued" },
            { id: "monitor", kind: "host-step", label: "watchdog", state: "running" },
          ],
        },
        {
          id: "run-2",
          kind: "subagent",
          label: "scout",
          state: "stopped",
          children: [
            { id: "step:0", kind: "step", label: "scout", state: "complete", endedAt: 20 },
            { id: "step:1", kind: "step", label: "writer", state: "queued" },
          ],
        },
        { id: "run-3", kind: "subagent", label: "unknown", state: "exploded" },
      ]),
    ]),
  ).toEqual([
    {
      id: "run-1",
      status: "running",
      steps: [
        {
          id: "task-1",
          title: "reviewer",
          label: "task-1",
          status: "running",
          model: "anthropic/claude-opus-5-5",
          currentTool: "bash",
          startedAt: 10,
          endedAt: undefined,
        },
        {
          id: "task-2",
          title: "task-2",
          label: "task-2",
          status: "pending",
          model: null,
          currentTool: undefined,
          startedAt: undefined,
          endedAt: undefined,
        },
      ],
    },
    {
      id: "run-2",
      status: "interrupted",
      steps: [
        {
          id: "step:0",
          title: "scout",
          label: "scout",
          status: "completed",
          model: null,
          currentTool: undefined,
          startedAt: undefined,
          endedAt: 20,
        },
        {
          id: "step:1",
          title: "writer",
          label: "writer",
          status: "interrupted",
          model: null,
          currentTool: undefined,
          startedAt: undefined,
          endedAt: undefined,
        },
      ],
    },
  ]);
});

it("treats a cleared widget as no runs and leaves other widget content alone", () => {
  expect(parsePiAsyncSubagentSnapshot(undefined)).toEqual([]);
  expect(parsePiAsyncSubagentSnapshot(["--- Subagents ---", "scout: running"])).toBeUndefined();
  expect(parsePiAsyncSubagentSnapshot(["PI_SUBAGENT_ASYNC_JSON:{not json"])).toBeUndefined();
  expect(
    parsePiAsyncSubagentSnapshot([`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({ kind: "other" })}`]),
  ).toBeUndefined();
});
