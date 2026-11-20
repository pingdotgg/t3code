import * as DateTime from "effect/DateTime";
import { makeThreadShellFixture } from "../test-fixtures";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  EMPTY_AGENT_WIDGET_SNAPSHOT,
  agentWidgetContentKey,
  buildAgentWidgetSnapshot,
  mergeWidgetUpdate,
} from "./agentWidgetSnapshot";

const environmentId = EnvironmentId.make("environment-1");
const project = { environmentId, id: ProjectId.make("project-1"), title: "Project" };
type WidgetThread = ReturnType<typeof makeThreadShellFixture>;
function thread(overrides: Partial<WidgetThread> = {}): WidgetThread {
  const shell = makeThreadShellFixture({
    environmentId,
    projectId: project.id,
    id: ThreadId.make("thread-1"),
    title: "Build staging",
    archivedAt: null,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtime: null,
    latestRun: null,
    updatedAt: "2026-09-06T18:00:00Z",
    hasPendingApprovals: false,
    hasPendingUserInput: true,
    ...overrides,
  });
  return {
    ...shell,
    source: {
      ...shell.source,
      updatedAt: DateTime.makeUnsafe(shell.updatedAt),
      status: shell.runtime?.status ?? "idle",
      activityRunStatus: shell.runtime?.status === "running" ? "running" : null,
      pendingRuntimeRequest:
        shell.hasPendingApprovals || shell.hasPendingUserInput
          ? {
              id: RuntimeRequestId.make("widget-request"),
              kind: shell.hasPendingApprovals ? "command" : "user_input",
              createdAt: DateTime.makeUnsafe(shell.updatedAt),
            }
          : null,
    },
  };
}

describe("agent widget snapshots", () => {
  it("keeps three threads by meaningful recency and counts unseen runs separately", () => {
    const at = (minute: string) => DateTime.makeUnsafe(`2026-09-06T18:${minute}:00Z`);
    const recent = (
      id: string,
      created: string,
      overrides: Partial<WidgetThread["source"]> = {},
    ) => {
      const base = thread({ id: ThreadId.make(id), hasPendingUserInput: false });
      return {
        ...base,
        source: { ...base.source, createdAt: at(created), updatedAt: at("59"), ...overrides },
      };
    };
    const snapshot = buildAgentWidgetSnapshot({
      projects: [project],
      captureWork: true,
      now: at("50").epochMilliseconds,
      threads: [
        recent("old-wait", "01", {
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request"),
            kind: "command",
            createdAt: at("02"),
          },
        }),
        recent("new", "05", { latestUserAuthoredMessageAt: at("15") }),
        recent("finished", "03", {
          status: "completed",
          latestRunCompletedAt: at("14"),
          lastVisitedAt: at("13"),
        }),
        recent("seen-failure", "04", {
          status: "failed",
          latestRunCompletedAt: at("12"),
          lastVisitedAt: at("13"),
        }),
        recent("deleted", "18", { deletedAt: at("19") }),
      ],
    });

    expect(snapshot.work?.recent.map(({ threadId }) => threadId)).toEqual([
      "new",
      "finished",
      "seen-failure",
    ]);
    expect(snapshot.work).toMatchObject({
      review: [{ threadId: "finished" }],
      finished: 1,
      failed: 0,
    });
    expect(snapshot.activities[0]?.threadId).toBe("old-wait");
  });

  it("keeps recent error details but excludes old failures from the widget", () => {
    const now = Date.parse("2026-09-06T18:10:00Z");
    const failed = thread({
      hasPendingUserInput: false,
      runtime: {
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "failed",
        providerName: "Codex",
        activeRunId: null,
        lastError: "Credential expired\nInternal stack details",
        updatedAt: "2026-09-06T18:00:00Z",
      },
    });
    const snapshot = buildAgentWidgetSnapshot({
      projects: [project],
      threads: [
        failed,
        thread({ ...failed, id: ThreadId.make("old"), updatedAt: "2026-09-05T18:00:00Z" }),
      ],
      now,
    });
    expect(snapshot.activities).toHaveLength(1);
    expect(snapshot.activities[0]?.detail).toBe("Credential expired");
    expect(snapshot.activeCount).toBe(0);
    const changed = buildAgentWidgetSnapshot({
      projects: [project],
      threads: [{ ...failed, runtime: { ...failed.runtime!, lastError: "Provider rate limit" } }],
      now,
    });
    expect(agentWidgetContentKey(changed)).not.toBe(agentWidgetContentKey(snapshot));
  });
  it("merges background updates per environment and ignores late or removed-server pushes", () => {
    const secondEnvironment = EnvironmentId.make("environment-2");
    const snapshot = buildAgentWidgetSnapshot({
      projects: [project, { ...project, environmentId: secondEnvironment }],
      threads: [thread(), thread({ environmentId: secondEnvironment })],
    });
    const update = {
      environmentId,
      attentionCount: 0,
      activity: {
        title: "Agent activity",
        subtitle: "All caught up",
        activeCount: 0,
        activities: [],
        updatedAt: "2026-09-06T19:00:00Z",
      },
    };
    const merged = mergeWidgetUpdate(snapshot, update);
    expect(merged.activeCount).toBe(1);
    expect(merged.attentionCount).toBe(1);
    expect(merged.activities.map((row) => row.environmentId)).toEqual([secondEnvironment]);
    expect(
      mergeWidgetUpdate(merged, {
        ...update,
        activity: { ...update.activity, updatedAt: "2026-09-06T17:00:00Z" },
      }),
    ).toBe(merged);
    const unknownServer = EnvironmentId.make("unknown");
    const seeded = mergeWidgetUpdate(merged, {
      ...update,
      environmentId: unknownServer,
      attentionCount: 1,
      activity: {
        ...update.activity,
        activeCount: 1,
        activities: [
          {
            environmentId: unknownServer,
            threadId: ThreadId.make("thread-9"),
            projectId: "project-9",
            projectTitle: "Elsewhere",
            threadTitle: "Waiting",
            modelTitle: "Model",
            phase: "waiting_for_input" as const,
            status: "Needs input",
            updatedAt: "2026-09-06T19:30:00Z",
            deepLink: "pseudocode://thread/thread-9",
          },
        ],
      },
    });
    expect(seeded.environments?.map((entry) => entry.environmentId)).toEqual([
      environmentId,
      secondEnvironment,
      unknownServer,
    ]);
    expect(seeded.attentionCount).toBe(2);
    expect(seeded.activities[0]?.environmentId).toBe(unknownServer);
  });

  it("seeds an empty widget from its first background push", () => {
    const update = {
      environmentId,
      attentionCount: 0,
      activity: {
        title: "Agent activity",
        subtitle: "Working",
        activeCount: 1,
        activities: [],
        updatedAt: "2026-09-06T19:00:00Z",
      },
    };
    const seeded = mergeWidgetUpdate(EMPTY_AGENT_WIDGET_SNAPSHOT, update);
    expect(seeded).not.toBe(EMPTY_AGENT_WIDGET_SNAPSHOT);
    expect(seeded.activeCount).toBe(1);
    expect(seeded.updatedAt).toBe("2026-09-06T19:00:00Z");
    expect(seeded.environments).toHaveLength(1);
  });
  it("publishes an empty state when no projects are connected", () => {
    expect(buildAgentWidgetSnapshot({ projects: [], threads: [] })).toEqual({
      activeCount: 0,
      attentionCount: 0,
      activities: [],
      updatedAt: null,
    });
  });

  it("prioritizes attention, counts all active work, and bounds the displayed rows", () => {
    const threads = Array.from({ length: 5 }, (_, index) =>
      thread({
        id: ThreadId.make(`thread-${index}`),
        hasPendingUserInput: index === 4,
        runtime: {
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "running",
          providerName: "Codex",
          activeRunId: null,
          lastError: null,
          updatedAt: "2026-09-06T18:00:00Z",
        },
      }),
    );
    const snapshot = buildAgentWidgetSnapshot({ projects: [project], threads });
    expect(snapshot.activeCount).toBe(5);
    expect(snapshot.attentionCount).toBe(1);
    expect(snapshot.activities).toHaveLength(5);
    expect(snapshot.activities[0]?.threadId).toBe("thread-4");
    expect(snapshot.activities[0]?.headline).toBe("Waiting for input");
  });

  it("keeps project names and deep links scoped to each environment", () => {
    const secondEnvironment = EnvironmentId.make("environment-2");
    const snapshot = buildAgentWidgetSnapshot({
      projects: [
        project,
        { ...project, environmentId: secondEnvironment, title: "Second project" },
      ],
      threads: [thread(), thread({ environmentId: secondEnvironment })],
    });
    expect(
      snapshot.activities.map((activity) => [activity.projectTitle, activity.deepLink]),
    ).toEqual([
      ["Project", "/threads/environment-1/thread-1"],
      ["Second project", "/threads/environment-2/thread-1"],
    ]);
  });

  it("drops archived threads, removed projects, and threads without activity", () => {
    const snapshot = buildAgentWidgetSnapshot({
      projects: [project],
      threads: [
        thread({ id: ThreadId.make("archived"), archivedAt: "2026-09-06T19:00:00Z" }),
        thread({ id: ThreadId.make("removed-project"), projectId: ProjectId.make("removed") }),
        thread({ id: ThreadId.make("idle"), hasPendingUserInput: false }),
      ],
    });
    expect(snapshot.activities).toEqual([]);
    expect(snapshot.activeCount).toBe(0);
  });

  it("does not reload for timestamp-only changes, but does for new requests or titles", () => {
    const initial = buildAgentWidgetSnapshot({ projects: [project], threads: [thread()] });
    const timestampOnly = buildAgentWidgetSnapshot({
      projects: [project],
      threads: [thread({ updatedAt: "2026-09-06T19:00:00Z" })],
    });
    const approval = buildAgentWidgetSnapshot({
      projects: [project],
      threads: [thread({ hasPendingApprovals: true })],
    });
    const renamed = buildAgentWidgetSnapshot({
      projects: [project],
      threads: [thread({ title: "New title" })],
    });
    expect(agentWidgetContentKey(timestampOnly)).toBe(agentWidgetContentKey(initial));
    expect(agentWidgetContentKey(approval)).not.toBe(agentWidgetContentKey(initial));
    expect(agentWidgetContentKey(renamed)).not.toBe(agentWidgetContentKey(initial));
  });
});
