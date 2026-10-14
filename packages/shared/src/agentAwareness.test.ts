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
        | "status"
        | "pendingBackgroundTasks"
        | "pendingRuntimeRequest"
        | "lineage"
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
    updatedAt,
    ...overrides,
  });

  it("projects V2 run state", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread(),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
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

  it("prioritizes V2 user-input requests", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-1"),
            kind: "user_input",
            createdAt: updatedAt,
          },
        }),
      }),
    ).toMatchObject({ phase: "waiting_for_input", headline: "Waiting for input" });
  });

  it("keeps a running thread with an async question running", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          status: "running",
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-async"),
            kind: "user_input",
            createdAt: updatedAt,
            blocking: false,
          },
        }),
      }),
    ).toMatchObject({ phase: "running" });
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
