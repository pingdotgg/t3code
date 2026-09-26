import { describe, expect, it } from "vite-plus/test";

import {
  childThreadActivityByParent,
  type ChildThreadActivityShell,
} from "./childThreadActivity.ts";

// Same convention as the fork's `sub.<parent>.<suffix>` child-thread ids.
function parentThreadIdOf(threadId: string): string | null {
  if (!threadId.startsWith("sub.") || threadId.lastIndexOf(".") <= 4) return null;
  return threadId.slice(4, threadId.lastIndexOf("."));
}

const SESSION_AT = "2026-09-25T09:00:00.000Z";

function shell(
  id: string,
  overrides: Partial<ChildThreadActivityShell> = {},
): ChildThreadActivityShell {
  return {
    id,
    archivedAt: null,
    session: { status: "ready", updatedAt: SESSION_AT },
    latestTurn: null,
    backgroundLiveness: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

const running = { session: { status: "running", updatedAt: SESSION_AT } };

function openTurn(startedAt: string) {
  return { requestedAt: startedAt, startedAt, completedAt: null };
}

const idle = {
  workingCount: 0,
  workingSince: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
};

function activityOf(shells: ReadonlyArray<ChildThreadActivityShell>) {
  return Object.fromEntries(childThreadActivityByParent(shells, parentThreadIdOf));
}

describe("childThreadActivityByParent", () => {
  it("has no entry for a thread without children or with only its own work", () => {
    expect(activityOf([shell("parent", running), shell("other")])).toEqual({});
  });

  it("counts working children, including a live background fleet after the turn", () => {
    expect(
      activityOf([
        shell("parent"),
        shell("sub.parent.coder-a", running),
        shell("sub.parent.coder-b", { session: { status: "starting", updatedAt: SESSION_AT } }),
        shell("sub.parent.coder-c", { backgroundLiveness: "working" }),
      ]),
    ).toEqual({ parent: { ...idle, workingCount: 3, workingSince: SESSION_AT } });
  });

  it("reports the earliest working child's start", () => {
    expect(
      activityOf([
        shell("parent"),
        shell("sub.parent.late", { ...running, latestTurn: openTurn("2026-09-25T11:30:00.000Z") }),
        shell("sub.parent.early", { ...running, latestTurn: openTurn("2026-09-25T11:00:00.000Z") }),
        // A waiting child does not start the timer.
        shell("sub.parent.asking", {
          ...running,
          latestTurn: openTurn("2026-09-25T08:00:00.000Z"),
          hasPendingUserInput: true,
        }),
      ]).parent?.workingSince,
    ).toBe("2026-09-25T11:00:00.000Z");
  });

  it("counts a nested child toward every ancestor", () => {
    const nested = { ...idle, workingCount: 1, workingSince: SESSION_AT };
    expect(
      activityOf([
        shell("parent"),
        shell("sub.parent.dispatcher"),
        shell("sub.sub.parent.dispatcher.coder", running),
      ]),
    ).toEqual({ parent: nested, "sub.parent.dispatcher": nested });
  });

  it("ignores finished and archived children", () => {
    expect(
      activityOf([
        shell("parent"),
        shell("sub.parent.done"),
        shell("sub.parent.archived", { ...running, archivedAt: "2026-09-01T00:00:00.000Z" }),
      ]),
    ).toEqual({});
  });

  it("keeps an entry, without working, for monitoring or failed children with background work", () => {
    expect(
      activityOf([
        shell("parent"),
        shell("sub.parent.failed", {
          session: { status: "error", updatedAt: SESSION_AT },
          backgroundLiveness: "working",
        }),
        shell("sub.parent.watching", { backgroundLiveness: "monitoring" }),
      ]),
    ).toEqual({ parent: idle });
  });

  it("surfaces a child awaiting approval without counting it as working", () => {
    expect(
      activityOf([
        shell("parent"),
        shell("sub.parent.coder", { ...running, hasPendingApprovals: true }),
      ]),
    ).toEqual({ parent: { ...idle, hasPendingApprovals: true } });
  });

  it("surfaces a child waiting on user input without counting it as working", () => {
    expect(
      activityOf([
        shell("parent"),
        shell("sub.parent.coder", { ...running, hasPendingUserInput: true }),
      ]),
    ).toEqual({ parent: { ...idle, hasPendingUserInput: true } });
  });
});
