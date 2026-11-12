import type { WorkflowRun } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  nestWorkflowRuns,
  readWorkflowQuestion,
  workflowRunDetail,
} from "./workflowsSettings.logic";

const run = (runId: string, parentRunId: string | null = null): WorkflowRun => ({
  runId,
  workflow: "release",
  version: 1,
  title: runId,
  status: "running",
  detail: null,
  result: null,
  pauses: 0,
  retired: false,
  parentRunId,
  startedAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  endedAt: null,
});

describe("nestWorkflowRuns", () => {
  it("puts invoked runs under their parent and keeps the order among siblings", () => {
    const nested = nestWorkflowRuns([
      run("grandchild", "child-new"),
      run("child-new", "parent"),
      run("other"),
      run("child-old", "parent"),
      run("parent"),
      run("orphan", "not-listed"),
    ]);
    expect(nested.map((entry) => [entry.run.runId, entry.depth])).toEqual([
      ["other", 0],
      ["parent", 0],
      ["child-new", 1],
      ["grandchild", 2],
      ["child-old", 1],
      ["orphan", 0],
    ]);
  });
});

describe("readWorkflowQuestion", () => {
  const question = (request: unknown) =>
    readWorkflowQuestion({
      runId: "run",
      name: "approve",
      request: request as never,
      askedAt: "2026-11-01T00:00:00.000Z",
    });

  it("reads the title, the choices and the body", () => {
    expect(
      question({ title: "Ship it?", choices: ["yes", "no"], data: { body: "Diff is small." } }),
    ).toEqual({ title: "Ship it?", choices: ["yes", "no"], body: "Diff is small." });
  });

  it("falls back to the question's name and drops parts of another shape", () => {
    expect(question({ choices: ["yes", 2], data: { body: 3 } })).toEqual({
      title: "approve",
      choices: ["yes"],
      body: null,
    });
    expect(question(null)).toEqual({ title: "approve", choices: [], body: null });
  });
});

describe("workflowRunDetail", () => {
  it("says what a waiting run waits on and leaves other details as they are", () => {
    expect(workflowRunDetail({ status: "waiting", detail: "agent review" })).toBe(
      "Waiting on agent review",
    );
    expect(workflowRunDetail({ status: "paused", detail: "apply: 503" })).toBe("apply: 503");
    expect(workflowRunDetail({ status: "running", detail: null })).toBeNull();
  });
});
