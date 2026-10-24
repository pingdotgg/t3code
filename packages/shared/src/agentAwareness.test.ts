import { describe, expect, it } from "@effect/vitest";

import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  Project,
  ThreadId,
} from "@t3tools/contracts";
import { ProviderInstanceId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { projectThreadAwarenessV2 } from "./agentAwareness.ts";

const NOW = "2026-05-22T12:00:00.000Z";

const project = {
  title: "t3code",
} satisfies Pick<Project, "title">;

describe("projectThreadAwarenessV2", () => {
  const updatedAt = DateTime.makeUnsafe(NOW);
  const v2Thread = (
    overrides: Partial<
      Pick<
        OrchestrationV2ThreadShell,
        | "activityRunStatus"
        | "latestRunStopRequested"
        | "status"
        | "pendingBackgroundTasks"
        | "pendingRuntimeRequest"
        | "lineage"
        | "settledOverride"
      >
    > = {},
  ) => ({
    id: "thread-2" as ThreadId,
    lineage: {
      rootThreadId: "thread-2" as ThreadId,
      parentThreadId: null,
      relationshipToParent: null,
    },
    title: "Integrate orchestration",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    status: "running" as const,
    pendingRuntimeRequest: null,
    settledOverride: null,
    updatedAt,
    ...overrides,
  });

  it("does not announce completion after a manual stop", () => {
    const input = {
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: v2Thread({ status: "completed" }),
    };
    expect(projectThreadAwarenessV2(input)?.phase).toBe("completed");
    expect(
      projectThreadAwarenessV2({
        ...input,
        thread: { ...input.thread, latestRunStopRequested: true },
      }),
    ).toBeNull();
  });

  it.each([
    ["running", null],
    ["completed", null],
    ["failed", "failed"],
  ] as const)("keeps an idle compaction's %s run quiet unless it fails", (status, phase) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: { ...v2Thread({ status }), latestRunSilent: true },
      })?.phase ?? null,
    ).toBe(phase);
  });

  it.each(["running", "completed", "failed"] as const)(
    "does not publish %s subagent activity",
    (status) => {
      expect(
        projectThreadAwarenessV2({
          environmentId: "env-1" as EnvironmentId,
          project,
          thread: v2Thread({
            status,
            lineage: {
              rootThreadId: "parent" as ThreadId,
              parentThreadId: "parent" as ThreadId,
              relationshipToParent: "subagent",
            },
          }),
        }),
      ).toBeNull();
    },
  );

  it("keeps an older activity run visible over a newer cancelled run", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "cancelled", activityRunStatus: "running" }),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });

  it.each(["completed", "failed"] as const)("removes settled %s work", (status) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status, settledOverride: "settled" }),
      }),
    ).toBeNull();
  });

  it.each(["starting", "running", "waiting"] as const)(
    "keeps settled %s work visible",
    (status) => {
      expect(
        projectThreadAwarenessV2({
          environmentId: "env-1" as EnvironmentId,
          project,
          thread: v2Thread({ status, settledOverride: "settled" }),
        }),
      ).toMatchObject({ phase: status === "starting" ? "starting" : "running" });
    },
  );

  it.each(["user_input", "command"] as const)(
    "keeps a settled terminal thread with a pending %s request",
    (kind) => {
      expect(
        projectThreadAwarenessV2({
          environmentId: "env-1" as EnvironmentId,
          project,
          thread: v2Thread({
            status: "completed",
            settledOverride: "settled",
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("request-settled"),
              kind,
              createdAt: updatedAt,
            },
          }),
        }),
      ).toMatchObject({
        phase: kind === "user_input" ? "waiting_for_input" : "waiting_for_approval",
      });
    },
  );

  it("keeps settled work held open by a monitor", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          status: "completed",
          settledOverride: "settled",
          pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor" }],
        }),
      }),
    ).toMatchObject({ phase: "running" });
  });

  it.each([
    ["only a dev server", "completed", [{ taskId: "dev", kind: "command" }]],
    ["a monitor", "running", [{ taskId: "watch", kind: "monitor" }]],
    [
      "a dev server and a subagent",
      "running",
      [
        { taskId: "dev", kind: "command" },
        { taskId: "review", kind: "subagent" },
      ],
    ],
  ] as const)("reports a completed run waiting on %s as %s", (_case, phase, tasks) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "completed", pendingBackgroundTasks: tasks }),
      }),
    ).toMatchObject({ phase });
  });

  it("reports an async question as input only after the working run completes", () => {
    const input = {
      environmentId: "env-1" as EnvironmentId,
      project,
      thread: v2Thread({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-async"),
          kind: "user_input",
          createdAt: updatedAt,
          blocking: false,
        },
      }),
    };
    expect(projectThreadAwarenessV2(input)).toMatchObject({
      phase: "running",
      headline: "Agent is working",
    });
    expect(
      projectThreadAwarenessV2({ ...input, thread: { ...input.thread, status: "completed" } }),
    ).toMatchObject({ phase: "waiting_for_input", headline: "Waiting for input" });
  });

  it("does not present authentication refreshes as user approvals", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-auth-refresh"),
            kind: "auth_refresh",
            createdAt: updatedAt,
          },
        }),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });
});
