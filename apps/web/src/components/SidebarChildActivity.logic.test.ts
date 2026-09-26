import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { resolveSidebarThreadStatus, resolveThreadStatusPill } from "./Sidebar.logic";
import {
  childAgentsLabel,
  childThreadActivityByThreadKey,
  resolveParentWorkingStartedAt,
  withChildThreadActivity,
} from "./SidebarChildActivity.logic";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");

function session(status: "running" | "ready" | "error") {
  return {
    threadId: ThreadId.make("thread"),
    status,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: DEFAULT_RUNTIME_MODE,
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-09-25T10:00:00.000Z",
  };
}

function shell(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId: LOCAL,
    id: ThreadId.make(id),
    projectId: ProjectId.make("project"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-25T09:00:00.000Z",
    updatedAt: "2026-09-25T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: session("ready"),
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

/** The parent row's status, label and pill as the sidebar derives them. */
function parentRow(threads: ReadonlyArray<EnvironmentThreadShell>, parentKey = "local:parent") {
  const parent = threads.find((thread) => `${thread.environmentId}:${thread.id}` === parentKey)!;
  const activity = childThreadActivityByThreadKey(threads).get(parentKey) ?? null;
  const statusThread = withChildThreadActivity(parent, activity);
  return {
    status: resolveSidebarThreadStatus(statusThread),
    pill: resolveThreadStatusPill({ thread: statusThread })?.label ?? null,
    agents: childAgentsLabel(activity),
    startedAt: resolveParentWorkingStartedAt(parent, activity),
  };
}

describe("parent row with child threads", () => {
  it("stays ready without children", () => {
    expect(parentRow([shell("parent")])).toMatchObject({
      status: "ready",
      pill: null,
      agents: null,
    });
  });

  it("shows Working with the number of working descendants", () => {
    expect(
      parentRow([
        shell("parent"),
        shell("sub.parent.coder", { session: session("running") }),
        shell("sub.parent.dispatcher", { backgroundLiveness: "working" }),
        shell("sub.sub.parent.dispatcher.reviewer", { session: session("running") }),
      ]),
    ).toMatchObject({ status: "working", pill: "Working", agents: "· 3 agents" });
    expect(
      parentRow([shell("parent"), shell("sub.parent.coder", { session: session("running") })])
        .agents,
    ).toBe("· 1 agent");
  });

  it("clears when the last child finishes", () => {
    expect(parentRow([shell("parent"), shell("sub.parent.coder")])).toMatchObject({
      status: "ready",
      pill: null,
      agents: null,
    });
  });

  it("surfaces a child awaiting approval as the parent's approval", () => {
    expect(
      parentRow([
        shell("parent"),
        shell("sub.parent.coder", { session: session("running"), hasPendingApprovals: true }),
        shell("sub.parent.reviewer", { session: session("running") }),
      ]),
    ).toMatchObject({ status: "approval", pill: "Pending Approval", agents: "· 1 agent" });
  });

  it("surfaces a child waiting on user input as the parent's input state", () => {
    expect(
      parentRow([
        shell("parent"),
        shell("sub.parent.coder", { session: session("running"), hasPendingUserInput: true }),
      ]),
    ).toMatchObject({ status: "input", pill: "Awaiting Input", agents: null });
  });

  it("does not show a monitoring-only child as work on the parent", () => {
    expect(
      parentRow([
        shell("parent"),
        shell("sub.parent.watcher", { backgroundLiveness: "monitoring" }),
      ]),
    ).toMatchObject({ status: "ready", pill: null, agents: null });
  });

  it("times an idle parent from its earliest working child, not its own idle session", () => {
    const turn = (startedAt: string) => ({
      turnId: TurnId.make(`turn-${startedAt}`),
      state: "running" as const,
      requestedAt: startedAt,
      startedAt,
      completedAt: null,
      assistantMessageId: null,
    });
    const children = [
      shell("sub.parent.a", {
        session: session("running"),
        latestTurn: turn("2026-09-25T11:30:00.000Z"),
      }),
      shell("sub.parent.b", {
        session: session("running"),
        latestTurn: turn("2026-09-25T11:00:00.000Z"),
      }),
    ];
    expect(parentRow([shell("parent"), ...children]).startedAt).toBe("2026-09-25T11:00:00.000Z");
    // A running parent keeps timing its own turn.
    expect(
      parentRow([
        shell("parent", {
          session: session("running"),
          latestTurn: turn("2026-09-25T11:45:00.000Z"),
        }),
        ...children,
      ]).startedAt,
    ).toBe("2026-09-25T11:45:00.000Z");
    // An idle parent with its own older fleet keeps the older start.
    expect(
      parentRow([
        shell("parent", {
          backgroundLiveness: "working",
          session: { ...session("ready"), updatedAt: "2026-09-25T10:00:00.000Z" },
        }),
        ...children,
      ]).startedAt,
    ).toBe("2026-09-25T10:00:00.000Z");
  });

  it("keeps the parent's own failure above child work, as with native fleets", () => {
    expect(
      parentRow([
        shell("parent", { session: session("error") }),
        shell("sub.parent.coder", { session: session("running") }),
      ]).status,
    ).toBe("failed");
  });

  it("keeps environments apart", () => {
    const threads = [
      shell("parent"),
      shell("parent", { environmentId: REMOTE }),
      shell("sub.parent.coder", { environmentId: REMOTE, session: session("running") }),
    ];
    expect(parentRow(threads).status).toBe("ready");
    expect(parentRow(threads, "remote:parent").status).toBe("working");
  });
});
