import { expect, it } from "vite-plus/test";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { makeThreadShellFixture } from "../test-fixtures";
import { buildWidgetUnsettledRows } from "./agentActivityWidgetThreads";

it("fills from the app's Unsettled list, excluding relay duplicates and hidden threads", () => {
  const thread = makeThreadShellFixture({
    id: ThreadId.make("local:done"),
    title: "Review the result",
    runtime: null,
  });
  const other = {
    ...thread,
    environmentId: EnvironmentId.make("other"),
    pinnedAt: "2026-01-01T00:00:00Z",
  };
  const rows = buildWidgetUnsettledRows({
    threads: [
      thread,
      other,
      { ...thread, id: ThreadId.make("settled"), settledOverride: "settled" },
      { ...thread, id: ThreadId.make("archived"), archivedAt: "2026-01-01T00:00:00Z" },
      { ...thread, id: ThreadId.make("deleted"), deletedAt: "2026-01-01T00:00:00Z" },
      { ...thread, id: ThreadId.make("snoozed"), snoozedUntil: "2027-01-01T00:00:00Z" },
      ...Array.from({ length: 8 }, (_, i) => ({
        ...thread,
        id: ThreadId.make(`extra-${i}`),
        ...(i === 0
          ? {
              pinnedAt: "2026-01-01T00:00:00Z",
              latestRun: {
                runId: RunId.make("done"),
                status: "completed" as const,
                requestedAt: null,
                startedAt: null,
                completedAt: "2026-01-01T00:00:00Z",
                assistantMessageId: null,
              },
            }
          : {}),
      })),
    ],
    projects: [{ environmentId: other.environmentId, id: other.projectId, title: "Other project" }],
    excluded: [
      {
        environmentId: thread.environmentId,
        threadId: thread.id,
        projectTitle: "Project",
        threadTitle: thread.title,
        phase: "running",
        status: "Working",
        deepLink: "/",
      },
    ],
    now: "2026-11-03T00:00:00Z",
    settlementEnvironmentIds: new Set([thread.environmentId, other.environmentId]),
    queuedThreadKeys: new Set(),
  });
  expect(rows).toHaveLength(7);
  expect(rows).toContainEqual(
    expect.objectContaining({ threadId: "extra-0", phase: "completed", status: "Done" }),
  );
  for (const id of ["settled", "archived", "deleted", "snoozed"]) {
    expect(rows.map((row) => row.threadId)).not.toContain(id);
  }
  expect(rows.filter((row) => row.threadId === thread.id)).toEqual([
    expect.objectContaining({
      environmentId: other.environmentId,
      projectTitle: "Other project",
      status: "Ready",
      deepLink: "/threads/other/local%3Adone",
    }),
  ]);
});
