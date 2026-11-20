import { beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AgentWidgetSnapshot } from "./agentWidgetSnapshot";
const storage = vi.hoisted(() => ({
  original: [] as { props: AgentWidgetSnapshot }[],
  overview: [] as { date: Date; props: AgentWidgetSnapshot }[],
}));
vi.mock("expo-linking", () => ({ createURL: () => "t3code-dev:///" }));
vi.mock("./AgentWidget", () => ({
  default: {
    updateSnapshot: (props: AgentWidgetSnapshot) => {
      storage.original = [{ props }];
    },
    getTimeline: async () => storage.original,
  },
}));
vi.mock("./pseudocode/OverviewWidget", () => ({
  default: {
    updateTimeline: (timeline: typeof storage.overview) => {
      storage.overview = timeline;
    },
    getTimeline: async () => storage.overview,
  },
}));
import { saveWidgetPush, saveWidgetSnapshot } from "./widgetStorage";
const environmentId = EnvironmentId.make("env");
const row = {
  environmentId,
  threadId: ThreadId.make("thread"),
  turnId: "turn",
  projectTitle: "Project",
  threadTitle: "Thread",
  phase: "running" as const,
  headline: "Working",
  modelTitle: "model",
  updatedAt: "2026-09-09T12:00:00.000Z",
  deepLink: "/threads/env/thread",
  projectIcon: "data:image/png;base64,aWNvbg==",
};
function snapshot(activity: AgentWidgetSnapshot["activities"][number] = row): AgentWidgetSnapshot {
  const state = {
    activeCount: 1,
    attentionCount: 0,
    activities: [activity],
    updatedAt: activity.updatedAt,
  };
  return { ...state, environments: [{ environmentId, snapshot: state }] };
}
beforeEach(() => {
  storage.original = [];
  storage.overview = [];
});

it("retains project icons through pushes and summaries through foreground sync, but clears a prior turn's summary", async () => {
  await saveWidgetSnapshot(snapshot());
  const { headline, projectIcon: _icon, ...activity } = row;
  await saveWidgetPush({
    environmentId,
    attentionCount: 0,
    activity: {
      title: "Activity",
      subtitle: "Working",
      activeCount: 1,
      updatedAt: "2026-09-09T12:01:00.000Z",
      activities: [{ ...activity, status: headline, summary: "Checking notification routing." }],
    },
  });
  expect(storage.overview[0]?.props.activities[0]).toMatchObject({
    projectIcon: row.projectIcon,
    summary: "Checking notification routing.",
  });
  await saveWidgetSnapshot(snapshot());
  expect(storage.overview[0]?.props.activities[0]?.summary).toBe("Checking notification routing.");
  await saveWidgetSnapshot(
    snapshot({ ...row, turnId: "next", updatedAt: "2026-09-09T12:02:00.000Z" }),
  );
  expect(storage.overview[0]?.props.activities[0]?.summary).toBeUndefined();
});

it("stores the installed app scheme and schedules a delayed-update rendering", async () => {
  await saveWidgetSnapshot(snapshot(), [environmentId]);
  expect(storage.overview[0]?.props.appScheme).toBe("t3code-dev");
  expect(storage.overview).toHaveLength(2);
  const checkedAt = storage.overview[0]?.props.environments?.[0]?.snapshot.checkedAt;
  expect(checkedAt).toBeDefined();
  expect(storage.overview[1]?.date.getTime()).toBe(Date.parse(checkedAt!) + 25 * 60_000);
});

it("omits missing timestamps and optional fields from WidgetKit property lists", async () => {
  const empty = { activeCount: 0, attentionCount: 0, updatedAt: null, activities: [] };
  await saveWidgetSnapshot({ ...empty, environments: [{ environmentId, snapshot: empty }] });

  expect(storage.original[0]?.props).not.toHaveProperty("updatedAt");
  expect(storage.original[0]?.props.environments?.[0]?.snapshot).not.toHaveProperty("updatedAt");
  expect(storage.overview[0]?.props.environments?.[0]?.snapshot).not.toHaveProperty("updatedAt");
  expect(storage.overview[0]?.props).not.toHaveProperty("overviewStaleAt");
});

it("does not roll an attention push back when an older foreground snapshot arrives", async () => {
  await saveWidgetSnapshot(snapshot());
  const { headline: _headline, projectIcon: _icon, ...activity } = row;
  await saveWidgetPush({
    environmentId,
    attentionCount: 1,
    activity: {
      title: "Activity",
      subtitle: "Needs you",
      activeCount: 1,
      updatedAt: "2026-09-09T12:01:00.000Z",
      activities: [
        {
          ...activity,
          phase: "waiting_for_input",
          status: "Needs input",
          summary: "Choose the deployment environment.",
        },
      ],
    },
  });
  await saveWidgetSnapshot(snapshot(), [environmentId]);
  expect(storage.overview[0]?.props.attentionCount).toBe(1);
  expect(storage.overview[0]?.props.environments?.[0]?.snapshot.checkedAt).toBeUndefined();
  expect(storage.overview[0]?.props.activities[0]).toMatchObject({
    phase: "waiting_for_input",
    summary: "Choose the deployment environment.",
  });
});

it("merges exact stats from a capped background push and preserves the foreground views", async () => {
  const work = {
    recent: [row],
    review: [],
    finished: 0,
    failed: 0,
  };
  await saveWidgetSnapshot({ ...snapshot(), work }, [environmentId]);
  await saveWidgetPush({
    environmentId,
    attentionCount: 7,
    approvalCount: 4,
    activeProjectCount: 3,
    activity: {
      title: "Activity",
      subtitle: "Needs you",
      activeCount: 9,
      updatedAt: "2026-09-09T12:01:00.000Z",
      activities: [],
    },
  });

  expect(storage.original[0]?.props.work).toBeUndefined();
  expect(storage.overview[0]?.props).toMatchObject({
    activeCount: 9,
    attentionCount: 7,
    approvalCount: 4,
    activeProjectCount: 3,
    work,
  });
});

it("keeps a project's resolved icon while foreground image loading restarts", async () => {
  await saveWidgetSnapshot(snapshot());
  const { projectIcon: _icon, ...withoutIcon } = row;
  await saveWidgetSnapshot(snapshot(withoutIcon));
  expect(storage.overview[0]?.props.activities[0]?.projectIcon).toBe(row.projectIcon);
});

it("reuses icons for another thread in the same project without crossing environments", async () => {
  await saveWidgetSnapshot(snapshot({ ...row, projectId: "project" }));
  const { projectIcon: _icon, ...withoutIcon } = row;
  await saveWidgetSnapshot(
    snapshot({ ...withoutIcon, projectId: "project", threadId: ThreadId.make("other") }),
  );
  expect(storage.overview[0]?.props.activities[0]?.projectIcon).toBe(row.projectIcon);
  const otherEnvironment = EnvironmentId.make("other-environment");
  await saveWidgetSnapshot({
    activeCount: 1,
    attentionCount: 0,
    updatedAt: row.updatedAt,
    activities: [{ ...withoutIcon, projectId: "project", environmentId: otherEnvironment }],
  });
  expect(storage.overview[0]?.props.activities[0]?.projectIcon).toBeUndefined();
});

it("restores a project's icon when a push rotates it out of the visible rows and back", async () => {
  const projectRow = { ...row, projectId: "project" };
  await saveWidgetSnapshot(snapshot(projectRow));
  const { headline, projectIcon: _icon, ...activity } = projectRow;
  const otherThread = {
    ...activity,
    threadId: ThreadId.make("other"),
    projectId: "other-project",
    status: headline,
  };
  await saveWidgetPush({
    environmentId,
    attentionCount: 0,
    activity: {
      title: "Activity",
      subtitle: "Working",
      activeCount: 1,
      updatedAt: "2026-09-09T12:01:00.000Z",
      activities: [otherThread],
    },
  });
  expect(storage.overview[0]?.props.activities[0]?.projectIcon).toBeUndefined();
  await saveWidgetPush({
    environmentId,
    attentionCount: 0,
    activity: {
      title: "Activity",
      subtitle: "Working",
      activeCount: 1,
      updatedAt: "2026-09-09T12:02:00.000Z",
      activities: [{ ...activity, status: headline, updatedAt: "2026-09-09T12:02:00.000Z" }],
    },
  });
  expect(storage.overview[0]?.props.activities[0]?.projectIcon).toBe(row.projectIcon);
});
