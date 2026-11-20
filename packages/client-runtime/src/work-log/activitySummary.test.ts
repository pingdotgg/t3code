import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  RunId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveActivitySummary, type ActivityItem } from "./activitySummary.ts";

const run1 = RunId.make("run-1");
const run2 = RunId.make("run-2");

let nextId = 0;
const base = (runId: typeof run1 | null, status: ActivityItem["status"]) => ({
  id: TurnItemId.make(`item-${(nextId += 1)}`),
  runId,
  status,
  title: null,
  updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
});

const command = (input: string, status: ActivityItem["status"], runId = run1): ActivityItem => ({
  ...base(runId, status),
  type: "command_execution",
  input,
});

const edit = (
  fileName: string,
  additions?: number,
  deletions?: number,
  status: ActivityItem["status"] = "completed",
): ActivityItem => ({
  ...base(run1, status),
  type: "file_change",
  fileName,
  ...(additions === undefined ? {} : { additions }),
  ...(deletions === undefined ? {} : { deletions }),
});

const summarize = (
  items: Parameters<typeof deriveActivitySummary>[0],
  workspaceRoot: string | null = null,
  runActive = false,
  activeRunId: typeof run1 | null = null,
  runStatus: "completed" | "interrupted" | "failed" | null = null,
) => deriveActivitySummary(items, workspaceRoot, runActive, activeRunId, runStatus);

describe("deriveActivitySummary", () => {
  it("reports the running item as now and finished work as done, in order", () => {
    const summary = summarize([
      command("bun test", "completed"),
      edit("apps/web/a.ts", 1, 0),
      command("vp lint", "running"),
    ]);

    expect(summary.phase).toBe("running");
    expect(summary.now).toBe("vp lint");
    expect(summary.done.map((step) => step.label)).toEqual(["bun test", "Edited a.ts"]);
    expect(summarize([edit("src/a.ts", 1, 0, "running")]).now).toBe("Editing a.ts");
  });

  it("only reports the latest run", () => {
    const summary = summarize([
      command("old command", "completed", run1),
      command("new command", "completed", run2),
    ]);

    expect(summary.done.map((step) => step.label)).toEqual(["new command"]);
    expect(summarize([{ ...command("native command", "completed"), runId: null }]).done).toEqual([
      { id: expect.any(String), label: "native command", failed: false },
    ]);
  });

  it("shows labels relative to the workspace", () => {
    const summary = summarize(
      [command("cat /repo/src/a.ts && ls /repo/docs", "completed")],
      "/repo/",
    );

    expect(summary.done.map((step) => step.label)).toEqual(["cat src/a.ts && ls docs"]);
  });

  it("stays running between steps while the run is active, and never reports an outcome", () => {
    const between = summarize([command("bun test", "completed")], null, true);

    expect(between.phase).toBe("running");
    expect(between.now).toBeNull();
    expect(between.outcome).toBeNull();
    expect(summarize([command("bun test", "completed")]).phase).toBe("idle");
    expect(summarize([], null, true).phase).toBe("running");
    const background = summarize([command("sleep 60", "running")], null, false, null, "completed");
    expect(background.phase).toBe("running");
    expect(background.now).toBe("sleep 60");
  });

  it("is waiting, not running, when the agent needs the user", () => {
    const summary = summarize([
      command("bun test", "completed"),
      command("vp lint", "running"),
      { ...base(run1, "waiting"), type: "approval_request" },
    ]);

    expect(summary.phase).toBe("waiting");
    expect(summary.now).toBe("Waiting for your approval");

    const answered = summarize([
      command("bun test", "completed"),
      { ...base(run1, "completed"), type: "approval_request" },
    ]);

    expect(answered.phase).toBe("idle");
    expect(answered.done.map((step) => step.label)).toEqual(["bun test"]);
  });

  it("marks failed steps and groups touched files by folder, summing repeat edits", () => {
    const summary = summarize([
      command("bun test", "failed"),
      edit("apps/web/a.ts", 2, 1),
      edit("apps/web/b.ts", 1, 0),
      edit("apps/web/a.ts", 3, 0),
      edit("README.md", 1, 1),
    ]);

    expect(summary.done[0]?.failed).toBe(true);
    expect(summary.touched).toEqual([
      {
        folder: "apps/web",
        files: [
          { path: "apps/web/a.ts", openable: true, additions: 5, deletions: 1 },
          { path: "apps/web/b.ts", openable: true, additions: 1, deletions: 0 },
        ],
      },
      { folder: ".", files: [{ path: "README.md", openable: true, additions: 1, deletions: 1 }] },
    ]);
  });

  it("does not list a file as touched until its edit ran", () => {
    const summary = summarize([
      edit("src/waiting.ts", 1, 0, "waiting"),
      edit("src/failed.ts", 1, 0, "failed"),
      edit("src/done.ts", 1, 0),
    ]);

    expect(summary.touched.flatMap((folder) => folder.files.map((file) => file.path))).toEqual([
      "src/done.ts",
    ]);
  });

  it("totals touched files, failures, and when the run last changed", () => {
    const summary = summarize([
      command("bun test", "failed"),
      edit("src/a.ts", 2, 1),
      edit("src/b.ts"),
      edit("lib/c.ts", 3, 0),
    ]);

    expect(summary.failedCount).toBe(1);
    expect(summary.touchedTotals).toEqual({ files: 3, additions: 5, deletions: 1 });
    expect(summary.lastActivityAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("does not label a bare 'Tool' title as work", () => {
    const summary = summarize([
      { ...base(run1, "completed"), type: "dynamic_tool", title: "Tool" },
      { ...base(run1, "completed"), type: "dynamic_tool", title: "Fetch docs" },
      // ACP updates that omit a title leave "Tool" on a command; its input says what ran.
      { ...command("vp test run", "failed"), title: "Tool" },
    ]);

    expect(summary.done.map((step) => step.label)).toEqual([
      "Used a tool",
      "Fetch docs",
      "vp test run",
    ]);
  });

  it("keeps line counts unknown when the provider reports none, instead of showing zero", () => {
    const summary = summarize([edit("src/a.ts"), edit("src/b.ts", 2, 0), edit("src/b.ts")]);

    expect(summary.touched[0]?.files).toEqual([
      { path: "src/a.ts", openable: true, additions: null, deletions: null },
      { path: "src/b.ts", openable: true, additions: 2, deletions: 0 },
    ]);
  });

  it("strips the workspace root only where a path starts, never inside another path", () => {
    const labels = (input: string, root: string | null) =>
      summarize([command(input, "completed")], root).done.map((step) => step.label);

    expect(labels("cat /var/app/src/a.ts", "/app")).toEqual(["cat /var/app/src/a.ts"]);
    expect(labels("cat /app/src/a.ts", "/app")).toEqual(["cat src/a.ts"]);
    expect(labels("cat /app/a.ts /app/b.ts", "/app")).toEqual(["cat a.ts b.ts"]);
    expect(labels("cd /a/b", "/")).toEqual(["cd /a/b"]);
    expect(labels("cd /a/b", "")).toEqual(["cd /a/b"]);
  });

  it("does not offer to open a relative path that leaves the workspace", () => {
    const opened = (fileName: string) =>
      summarize([edit(fileName, 1, 0)], "/repo").touched[0]?.files[0]?.openable;

    expect(opened("src/a.ts")).toBe(true);
    expect(opened("../outside.md")).toBe(false);
    expect(opened("src/../../outside.md")).toBe(false);
    expect(opened("src/../b.ts")).toBe(true);
  });

  it("turns absolute paths into workspace paths and flags files outside the workspace", () => {
    const summary = summarize(
      [edit("/repo/apps/web/a.ts", 1, 0), edit("/elsewhere/notes.md", 1, 0)],
      "/repo",
    );

    expect(summary.touched).toEqual([
      {
        folder: "apps/web",
        files: [{ path: "apps/web/a.ts", openable: true, additions: 1, deletions: 0 }],
      },
      {
        folder: "/elsewhere",
        files: [{ path: "/elsewhere/notes.md", openable: false, additions: 1, deletions: 0 }],
      },
    ]);
  });

  it("lists every file of a multi-file edit, without guessing per-file line counts", () => {
    const summary = summarize([
      {
        ...base(run1, "completed"),
        type: "file_change",
        fileName: "src/a.ts",
        additions: 4,
        deletions: 2,
        changes: [
          { operation: "update", path: "src/a.ts" },
          { operation: "add", path: "src/b.ts" },
        ],
      },
    ]);

    expect(summary.touched).toEqual([
      {
        folder: "src",
        files: [
          { path: "src/a.ts", openable: true, additions: null, deletions: null },
          { path: "src/b.ts", openable: true, additions: null, deletions: null },
        ],
      },
    ]);
  });

  it("reports the newest update as last activity, whatever order items arrive in", () => {
    const at = (updatedAt: string) => ({
      ...command("ls", "completed"),
      updatedAt: DateTime.makeUnsafe(updatedAt),
    });

    expect(summarize([at("2026-01-01T00:05:00Z"), at("2026-01-01T00:01:00Z")]).lastActivityAt).toBe(
      "2026-01-01T00:05:00.000Z",
    );
  });

  it("counts a run that ended in an error as failed, but not an error the agent is retrying", () => {
    const error = (status: ActivityItem["status"], retry?: { attempt: number }): ActivityItem => ({
      ...base(run1, status),
      type: "error",
      failure: { class: "unknown", message: "Provider crashed", code: null, retryable: false },
      ...(retry === undefined ? {} : { retry: { ...retry, maxAttempts: 3, retryDelayMs: 1000 } }),
    });

    const failed = summarize([command("bun test", "completed"), error("failed")]);
    expect(failed.outcome).toBe("failed");
    expect(failed.done.map((step) => step.label)).toEqual(["bun test", "Provider crashed"]);

    expect(
      summarize([command("bun test", "completed"), error("failed", { attempt: 1 })]).outcome,
    ).toBe("finished");
  });

  it("treats a run that only produced non-activity items as the latest run", () => {
    const summary = summarize([
      command("old command", "completed", run1),
      { ...base(run2, "completed"), type: "system_notice" },
    ]);

    expect(summary.done).toEqual([]);
  });

  it("shows nothing for a new run that has only started preparing its workspace", () => {
    const preparing = summarize([
      command("old command", "completed", run1),
      command("Preparing workspace", "running", run2),
    ]);
    expect(preparing.done).toEqual([]);
    expect(preparing.now).toBeNull();

    const cancelled = summarize([
      command("old command", "completed", run1),
      {
        ...base(run2, "cancelled"),
        type: "error",
        failure: {
          class: "unknown",
          message: "Workspace setup cancelled",
          code: ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
          retryable: null,
        },
      },
    ]);
    expect(cancelled.done).toEqual([]);
    expect(cancelled.failedCount).toBe(0);
  });

  it("shows the active run's own state while it has no items yet, not the previous run's", () => {
    const summary = summarize([command("old command", "completed", run1)], null, true, run2);

    expect(summary.phase).toBe("running");
    expect(summary.done).toEqual([]);
    expect(summary.touched).toEqual([]);
    expect(summary.plan).toBeNull();
  });

  it("shows the plan only when the provider sent a todo list, with a completed count", () => {
    expect(summarize([command("ls", "completed")]).plan).toBeNull();

    const summary = summarize([
      {
        ...base(run1, "completed"),
        type: "todo_list",
        steps: [
          { id: "1", text: "Read", status: "completed" },
          { id: "2", text: "Write", status: "running" },
          { id: "3", text: "Test", status: "pending" },
        ],
      },
    ]);

    expect(summary.plan?.completed).toBe(1);
    expect(summary.plan?.steps).toHaveLength(3);
  });

  it("says how an idle run ended: finished, failed, or stopped with plan steps left", () => {
    const plan = (statuses: Array<"pending" | "running" | "completed">): ActivityItem => ({
      ...base(run1, "completed"),
      type: "todo_list",
      steps: statuses.map((status, index) => ({
        id: String(index),
        text: `Step ${index}`,
        status,
      })),
    });

    expect(summarize([command("ls", "completed")]).outcome).toBe("finished");
    expect(summarize([plan(["completed", "completed"])]).outcome).toBe("finished");
    expect(summarize([plan(["completed", "running", "pending"])]).outcome).toBe("incomplete");
    expect(summarize([command("bun test", "failed"), plan(["completed", "pending"])]).outcome).toBe(
      "failed",
    );
    expect(summarize([command("vp lint", "running")]).outcome).toBeNull();
    expect(
      summarize(
        [command("pwd", "completed"), command("sleep 90", "interrupted")],
        null,
        false,
        null,
        "interrupted",
      ).outcome,
    ).toBe("stopped");
    expect(summarize([], null, false, null, "failed").outcome).toBe("failed");
  });

  it("is idle with nothing to show for an empty thread", () => {
    expect(summarize([])).toEqual({
      phase: "idle",
      outcome: "finished",
      now: null,
      done: [],
      failedCount: 0,
      touched: [],
      touchedTotals: { files: 0, additions: null, deletions: null },
      lastActivityAt: null,
      plan: null,
    });
  });
});
