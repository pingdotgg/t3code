import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadStatus } from "./threadPresentation";

const NOW = "2026-06-02T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");

type ThreadSession = NonNullable<EnvironmentThreadShell["session"]>;

function makeSession(status: ThreadSession["status"]): ThreadSession {
  return {
    threadId,
    status,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

function makeThread(input: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: threadId,
    title: "Thread",
    environmentId: EnvironmentId.make("environment-1"),
    projectId: ProjectId.make("project-1"),
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
    session: makeSession("ready"),
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

describe("resolveThreadStatus", () => {
  it("keeps the working presentation while subagents run past the parent turn", () => {
    expect(resolveThreadStatus(makeThread({ outstandingBackgroundTaskCount: 2 }))).toMatchObject({
      kind: "working",
      label: "Working",
      pulse: true,
    });
  });

  it("falls quiet once the outstanding count drains to zero", () => {
    expect(resolveThreadStatus(makeThread({ outstandingBackgroundTaskCount: 0 }))).toBeNull();
  });

  it("reads a legacy server's missing count as no background work", () => {
    expect(resolveThreadStatus(makeThread())).toBeNull();
  });

  it("keeps an errored session ahead of background work", () => {
    expect(
      resolveThreadStatus(
        makeThread({ outstandingBackgroundTaskCount: 1, session: makeSession("error") }),
      ),
    ).toMatchObject({ kind: "error" });
  });
});
