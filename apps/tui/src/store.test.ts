import { describe, expect, it } from "bun:test";

import type { OrchestrationShellSnapshot, OrchestrationThread, TuiClient } from "./connection.ts";
import { createStore } from "./store.ts";

/** A fake TuiClient that captures the shell/thread callbacks so the test can drive them. */
function fakeClient() {
  let onShell: ((s: OrchestrationShellSnapshot) => void) | null = null;
  const threadSubs: string[] = [];
  const client = {
    subscribeShell: (cb: (s: OrchestrationShellSnapshot) => void) => {
      onShell = cb;
      return () => {};
    },
    subscribeThread: (threadId: string) => {
      threadSubs.push(threadId);
      return () => {};
    },
    peekThread: () => null as OrchestrationThread | null,
  } as unknown as TuiClient;
  return {
    client,
    pushShell: (s: OrchestrationShellSnapshot) => onShell?.(s),
    threadSubs,
  };
}

const shell = (
  projects: ReadonlyArray<{ id: string; title: string }>,
  threads: ReadonlyArray<{ id: string; projectId: string; updatedAt: string; title?: string }>,
): OrchestrationShellSnapshot => ({ projects, threads }) as unknown as OrchestrationShellSnapshot;

const oneProjectTwoThreads = shell([{ id: "p1", title: "P1" }], [
  { id: "t1", projectId: "p1", updatedAt: "2020-01-02T00:00:00.000Z" },
  { id: "t2", projectId: "p1", updatedAt: "2020-01-01T00:00:00.000Z" },
]);

describe("createStore", () => {
  it("Given a shell snapshot, when pushed, then it populates state and a project-count status", () => {
    const f = fakeClient();
    const store = createStore(f.client);
    store.start();
    f.pushShell(oneProjectTwoThreads);
    const state = store.getState();
    expect(state.shell).not.toBeNull();
    expect(state.status).toBe("1 project(s) · 2 thread(s)");
  });

  it("Given collapsed projects, when a snapshot arrives, then the selection lands on the first project", () => {
    const f = fakeClient();
    const store = createStore(f.client);
    store.start();
    f.pushShell(oneProjectTwoThreads);
    expect(store.getState().selection).toEqual({ kind: "project", id: "p1" });
  });

  it("Given a collapsed project, when toggled, then it expands and selects it", () => {
    const f = fakeClient();
    const store = createStore(f.client);
    store.start();
    f.pushShell(oneProjectTwoThreads);
    store.toggleProject("p1");
    expect(store.getState().expanded.has("p1")).toBe(true);
    expect(store.getState().selection).toEqual({ kind: "project", id: "p1" });
  });

  it("Given an expanded project, when moving the selection down, then it selects the first thread and subscribes to it", () => {
    const f = fakeClient();
    const store = createStore(f.client);
    store.start();
    f.pushShell(oneProjectTwoThreads);
    store.toggleProject("p1");
    store.moveSelection(1);
    // threads are sorted by updatedAt desc → t1 first.
    expect(store.getState().selection).toEqual({ kind: "thread", id: "t1" });
    expect(f.threadSubs).toContain("t1");
  });

  it("Given setStatus, then the status text updates", () => {
    const f = fakeClient();
    const store = createStore(f.client);
    store.setStatus("Reply sent.");
    expect(store.getState().status).toBe("Reply sent.");
  });

  it("Given setStatus with a kind, then the status tone is recorded", () => {
    const f = fakeClient();
    const store = createStore(f.client);
    store.setStatus("send failed", "error");
    expect(store.getState().statusKind).toBe("error");
  });

  it("Given a thread is selected, when a filter hides it, then the selection re-validates onto a remaining match", () => {
    const f = fakeClient();
    const store = createStore(f.client);
    store.start();
    f.pushShell(
      shell([{ id: "p1", title: "P1" }], [
        { id: "t1", projectId: "p1", updatedAt: "2020-01-02T00:00:00.000Z", title: "login" },
        { id: "t2", projectId: "p1", updatedAt: "2020-01-01T00:00:00.000Z", title: "theme" },
      ]),
    );
    store.toggleProject("p1");
    store.select({ kind: "thread", id: "t1" });
    store.setFilter("theme");
    expect(store.getState().filter).toBe("theme");
    // t1 ("login") is filtered out, so the selection lands on the remaining match t2.
    expect(store.getState().selection).toEqual({ kind: "thread", id: "t2" });
  });
});
