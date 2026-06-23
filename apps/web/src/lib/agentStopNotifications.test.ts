import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationSessionStatus } from "@t3tools/contracts";

import {
  decideAgentStopNotifications,
  type ProjectLike,
  type ThreadShellLike,
} from "./agentStopNotifications.ts";

const project: ProjectLike = { id: "project-1", title: "Lucentive" };

function thread(
  status: OrchestrationSessionStatus | null,
  over: Partial<ThreadShellLike> = {},
): ThreadShellLike {
  return {
    id: "thread-1",
    projectId: "project-1",
    environmentId: "env-1",
    title: "Fix login bug",
    session: status === null ? null : { status },
    hasPendingUserInput: false,
    hasPendingApprovals: false,
    ...over,
  };
}

const settings = { popup: true, sound: true, soundSource: "tone" as const };

function run(prev: ReadonlyMap<string, OrchestrationSessionStatus>, threads: ThreadShellLike[]) {
  return decideAgentStopNotifications({
    prevStatuses: prev,
    threads,
    projects: [project],
    settings,
    activeThreadId: null,
    isAppFocused: false,
  });
}

describe("decideAgentStopNotifications", () => {
  it("does not fire on first sighting, but records status", () => {
    const result = run(new Map(), [thread("running")]);
    expect(result.notifications).toEqual([]);
    expect(result.nextStatuses.get("thread-1")).toBe("running");
  });

  it("fires 'finished' on running -> idle", () => {
    const result = run(new Map([["thread-1", "running"]]), [thread("idle")]);
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]).toMatchObject({
      threadId: "thread-1",
      environmentId: "env-1",
      title: "Fix login bug",
      body: "Lucentive · finished",
      status: "finished",
    });
  });

  it("fires 'errored' on running -> error", () => {
    const result = run(new Map([["thread-1", "running"]]), [thread("error")]);
    expect(result.notifications[0]).toMatchObject({
      body: "Lucentive · errored",
      status: "errored",
    });
  });

  it("fires 'finished' on running -> ready", () => {
    const result = run(new Map([["thread-1", "running"]]), [thread("ready")]);
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]!.status).toBe("finished");
  });

  it("fires 'awaiting input' when finished with pending user input", () => {
    const result = run(new Map([["thread-1", "running"]]), [
      thread("idle", { hasPendingUserInput: true }),
    ]);
    expect(result.notifications[0]).toMatchObject({
      body: "Lucentive · awaiting input",
      status: "awaiting input",
    });
  });

  it("fires 'awaiting input' when finished with pending approvals", () => {
    const result = run(new Map([["thread-1", "running"]]), [
      thread("idle", { hasPendingApprovals: true }),
    ]);
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]!).toMatchObject({
      body: "Lucentive · awaiting input",
      status: "awaiting input",
    });
  });

  it("does NOT fire on user-initiated stop or interrupt", () => {
    expect(run(new Map([["thread-1", "running"]]), [thread("stopped")]).notifications).toEqual([]);
    expect(run(new Map([["thread-1", "running"]]), [thread("interrupted")]).notifications).toEqual(
      [],
    );
  });

  it("suppresses when focused on that exact thread", () => {
    const result = decideAgentStopNotifications({
      prevStatuses: new Map([["thread-1", "running"]]),
      threads: [thread("idle")],
      projects: [project],
      settings,
      activeThreadId: "thread-1",
      isAppFocused: true,
    });
    expect(result.notifications).toEqual([]);
  });

  it("still fires when focused on a DIFFERENT thread", () => {
    const result = decideAgentStopNotifications({
      prevStatuses: new Map([["thread-1", "running"]]),
      threads: [thread("idle")],
      projects: [project],
      settings,
      activeThreadId: "other-thread",
      isAppFocused: true,
    });
    expect(result.notifications).toHaveLength(1);
  });

  it("updates nextStatuses even when both toggles are off, and emits nothing", () => {
    const result = decideAgentStopNotifications({
      prevStatuses: new Map([["thread-1", "running"]]),
      threads: [thread("idle")],
      projects: [project],
      settings: { popup: false, sound: false, soundSource: "tone" },
      activeThreadId: null,
      isAppFocused: false,
    });
    expect(result.notifications).toEqual([]);
    expect(result.nextStatuses.get("thread-1")).toBe("idle");
  });

  it("drops removed threads from nextStatuses", () => {
    const result = run(new Map([["thread-1", "running"]]), []);
    expect(result.nextStatuses.has("thread-1")).toBe(false);
  });

  it("falls back to a generic project name when the project is missing", () => {
    const result = decideAgentStopNotifications({
      prevStatuses: new Map([["thread-1", "running"]]),
      threads: [thread("idle", { projectId: "missing" })],
      projects: [project],
      settings,
      activeThreadId: null,
      isAppFocused: false,
    });
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]!.body).toBe("Unknown project · finished");
  });

  it("still fires when on that thread but the window is unfocused", () => {
    const result = decideAgentStopNotifications({
      prevStatuses: new Map([["thread-1", "running"]]),
      threads: [thread("idle")],
      projects: [project],
      settings,
      activeThreadId: "thread-1",
      isAppFocused: false,
    });
    expect(result.notifications).toHaveLength(1);
  });

  it("labels 'errored' even when pending input is set (error takes precedence)", () => {
    const result = run(new Map([["thread-1", "running"]]), [
      thread("error", { hasPendingUserInput: true }),
    ]);
    expect(result.notifications[0]).toMatchObject({
      status: "errored",
      body: "Lucentive · errored",
    });
  });
});
