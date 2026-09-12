import { NodeId, PlanId, ProjectId, RunId } from "@t3tools/contracts";
import {
  getLatestThreadForProject,
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  sortThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import { formatHourShort, formatRelativeHourShort } from "@t3tools/shared/usageFormat";
import { bench, describe } from "vite-plus/test";

import { makeThreadProjectionFixture } from "./test-fixtures";
import { deriveActivePlanState } from "./session-logic";

const projectId = ProjectId.make("benchmark-project");
const runId = RunId.make("benchmark-run");
const start = Date.parse("2026-08-11T00:00:00.000Z");
const threads = Array.from({ length: 1_000 }, (_, index) => {
  const timestamp = new Date(start + ((index * 997) % 1_000) * 60_000).toISOString();
  return {
    id: `thread-${index}`,
    projectId,
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    latestUserMessageAt: timestamp,
    unsettledAt: null,
  };
});
const baseProjection = makeThreadProjectionFixture();
const projection = {
  ...baseProjection,
  plans: Array.from({ length: 5 }, (_, index) => ({
    id: PlanId.make(`plan-${index}`),
    runId,
    threadId: baseProjection.thread.id,
    nodeId: NodeId.make("bench-node"),
    status: "active" as const,
    kind: "todo_list" as const,
    steps: [{ id: "check", text: "Run checks", status: "running" as const }],
  })),
};
const hours = Array.from({ length: 24 }, (_, index) =>
  new Date(start + index * 3_600_000).toISOString(),
);
const referenceTime = "2026-08-12T00:00:00.000Z";

describe("client performance", () => {
  bench("sort 1000 threads by recent activity", () => {
    sortThreads(threads, "updated_at");
  });
  bench("sort 1000 active threads", () => {
    sortActiveThreadsByOrderKey(threads);
  });
  bench("sort 1000 keyless pinned threads", () => {
    sortPinnedThreadsByOrderKey(threads);
  });
  bench("select latest project thread from 1000 threads", () => {
    getLatestThreadForProject(threads, projectId, "updated_at");
  });
  bench("derive current plan from 5 normalized plans", () => {
    deriveActivePlanState(projection, runId);
  });
  bench("format 24 hourly usage labels and tooltips", () => {
    hours.map((hour) => [
      formatHourShort(hour, "America/New_York"),
      formatRelativeHourShort(hour, referenceTime, "America/New_York"),
    ]);
  });
});
