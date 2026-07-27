import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { resolveThreadStatus } from "./threadPresentation";

const environmentId = EnvironmentId.make("environment-1");
const NOW = "2026-06-02T00:00:00.000Z";

function makeThread(input: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return makeThreadShellFixture({
    environmentId,
    id: ThreadId.make("t"),
    title: "t",
    ...input,
  });
}

type ThreadRuntime = NonNullable<EnvironmentThreadShell["runtime"]>;
type ThreadRun = NonNullable<EnvironmentThreadShell["latestRun"]>;

function latestRun(status: ThreadRun["status"], completedAt: string | null): ThreadRun {
  return {
    runId: RunId.make("run-t"),
    status,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt,
    assistantMessageId: null,
  };
}

function runtime(status: ThreadRuntime["status"]): ThreadRuntime {
  return {
    status,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: NOW,
  };
}

describe("resolveThreadStatus waiting", () => {
  it("reports a static muted Waiting pill for a nonempty background roster", () => {
    const status = resolveThreadStatus(
      makeThread({
        pendingBackgroundTasks: [{ taskId: "bg-1", description: "Run Codex review" }],
        runtime: runtime("idle"),
      }),
    );

    expect(status?.kind).toBe("waiting");
    expect(status?.label).toBe("Waiting");
    expect(status?.pulse).toBe(false);
  });

  it("reports nothing once the roster drains", () => {
    expect(
      resolveThreadStatus(makeThread({ pendingBackgroundTasks: [], runtime: runtime("idle") })),
    ).toBeNull();
  });

  it("wins over a stale non-terminal latestRun once the bridge parks runtime idle", () => {
    // The shape the presentation bridge actually emits post-settlement: the
    // roster parks runtime at idle while latestRun still reads as active.
    const status = resolveThreadStatus(
      makeThread({
        pendingBackgroundTasks: [{ taskId: "bg-1", description: "Run Codex review" }],
        runtime: runtime("idle"),
        latestRun: latestRun("running", null),
      }),
    );

    expect(status?.kind).toBe("waiting");
  });

  it("wins over Plan Ready", () => {
    const status = resolveThreadStatus(
      makeThread({
        pendingBackgroundTasks: [{ taskId: "bg-1", description: "Run Codex review" }],
        runtime: runtime("idle"),
        interactionMode: "plan",
        hasActionableProposedPlan: true,
        latestRun: latestRun("completed", NOW),
      }),
    );

    expect(status?.kind).toBe("waiting");
  });

  // Guards the resolver itself, not a shape the bridge emits: parking means a
  // nonempty roster arrives with runtime idle. If parking is ever dropped,
  // active work must still win.
  it("keeps active work ahead of Waiting", () => {
    const status = resolveThreadStatus(
      makeThread({
        pendingBackgroundTasks: [{ taskId: "bg-1", description: "Run Codex review" }],
        runtime: {
          ...runtime("running"),
          activeRunId: RunId.make("run-t"),
        },
      }),
    );

    expect(status?.kind).toBe("working");
  });

  it("keeps approvals, input, and failures ahead of Waiting", () => {
    const pendingBackgroundTasks = [{ taskId: "bg-1", description: "Run Codex review" }];

    expect(
      resolveThreadStatus(
        makeThread({ pendingBackgroundTasks, hasPendingApprovals: true, runtime: runtime("idle") }),
      )?.kind,
    ).toBe("pending-approval");
    expect(
      resolveThreadStatus(
        makeThread({ pendingBackgroundTasks, hasPendingUserInput: true, runtime: runtime("idle") }),
      )?.kind,
    ).toBe("awaiting-input");
    expect(
      resolveThreadStatus(makeThread({ pendingBackgroundTasks, runtime: runtime("failed") }))?.kind,
    ).toBe("error");
  });
});
