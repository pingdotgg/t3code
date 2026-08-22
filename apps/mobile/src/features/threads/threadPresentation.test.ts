import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadBackgroundLiveness, resolveThreadStatus } from "./threadPresentation";

const NOW = "2026-06-02T00:00:00.000Z";

function makeThread(input: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

describe("resolveThreadStatus background liveness", () => {
  it("stays working after the parent settles and clears with liveness", () => {
    const thread = makeThread({
      backgroundLiveness: "working",
      latestTurn: {
        turnId: TurnId.make("turn-background"),
        state: "completed",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: null,
      },
    });

    expect(resolveThreadStatus(thread)).toMatchObject({
      kind: "working",
      label: "Working",
      pulse: false,
    });
    expect(resolveThreadStatus({ ...thread, backgroundLiveness: null })).toBeNull();
    expect(resolveThreadStatus({ ...thread, backgroundLiveness: undefined })).toBeNull();
  });

  it("distinguishes monitoring as a static live state", () => {
    expect(resolveThreadStatus(makeThread({ backgroundLiveness: "monitoring" }))).toMatchObject({
      kind: "monitoring",
      label: "Monitoring",
      pulse: false,
    });
  });

  it("keeps actionable failures ahead of background liveness", () => {
    const threadId = ThreadId.make("thread-error");

    expect(
      resolveThreadStatus(
        makeThread({
          id: threadId,
          backgroundLiveness: "working",
          session: {
            threadId,
            status: "error",
            providerName: "Codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "Provider exited",
            updatedAt: NOW,
          },
        }),
      ),
    ).toMatchObject({ kind: "error", label: "Error" });
  });
});

describe("resolveThreadBackgroundLiveness", () => {
  it("suppresses stale liveness after terminal session outcomes", () => {
    for (const status of ["error", "stopped", "interrupted"] as const) {
      const threadId = ThreadId.make(`thread-${status}`);
      expect(
        resolveThreadBackgroundLiveness(
          makeThread({
            id: threadId,
            backgroundLiveness: "working",
            session: {
              threadId,
              status,
              providerName: "Codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: status === "error" ? "Provider exited" : null,
              updatedAt: NOW,
            },
          }),
        ),
      ).toBeNull();
    }
  });
});
