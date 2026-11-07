import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createGitActionQueue } from "./gitActionQueue.ts";
import type { EnvironmentThreadShell } from "./models.ts";

const REF = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const shellWith = (
  status: string,
  overrides: Partial<Pick<EnvironmentThreadShell, "worktreePath" | "pendingBackgroundTasks">> = {},
) =>
  ({
    runtime: { status, activeRunId: null },
    worktreePath: null,
    pendingBackgroundTasks: [],
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

function setup(status = "running") {
  const registry = AtomRegistry.make();
  const shell = Atom.make<EnvironmentThreadShell | null>(shellWith(status)).pipe(Atom.keepAlive);
  const queue = createGitActionQueue({ registry, threadShellAtom: () => shell });
  const run = vi.fn();
  const onDropped = vi.fn();
  return {
    queue,
    run,
    onDropped,
    setShell: (next: EnvironmentThreadShell | null) => registry.set(shell, next),
    queued: () => registry.get(queue.queuedActionAtom(REF)),
    enqueue: () => queue.enqueue(REF, { action: "commit", run, onDropped }),
  };
}

describe("createGitActionQueue", () => {
  it.each(["completed", "idle"])("runs once the thread is %s", (status) => {
    const h = setup();
    h.enqueue();
    expect(h.queued()).toBe("commit");
    h.setShell(shellWith("waiting"));
    expect(h.run).not.toHaveBeenCalled();

    h.setShell(shellWith(status));
    expect(h.run).toHaveBeenCalledOnce();
    h.setShell(shellWith("completed"));
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.onDropped).not.toHaveBeenCalled();
    expect(h.queued()).toBeNull();
  });

  it.each(["failed", "interrupted", "cancelled", "rolled_back"])(
    "drops the action when the run ends %s",
    (status) => {
      const h = setup();
      h.enqueue();
      h.setShell(shellWith(status));
      expect(h.run).not.toHaveBeenCalled();
      expect(h.onDropped).toHaveBeenCalledOnce();
      expect(h.queued()).toBeNull();
    },
  );

  it("waits out background work the agent is parked on", () => {
    const h = setup();
    h.enqueue();
    const awaited = [{ kind: "command", awaited: true }] as never;
    h.setShell(shellWith("idle", { pendingBackgroundTasks: awaited }));
    expect(h.run).not.toHaveBeenCalled();
    expect(h.queued()).toBe("commit");

    h.setShell(shellWith("idle"));
    expect(h.run).toHaveBeenCalledOnce();
  });

  it("drops the action when the thread moves to another checkout", () => {
    const h = setup();
    h.enqueue();
    h.setShell(shellWith("running", { worktreePath: "/other" }));
    expect(h.run).not.toHaveBeenCalled();
    expect(h.onDropped).toHaveBeenCalledOnce();
    expect(h.queued()).toBeNull();
  });

  it("drops the action when the thread goes away", () => {
    const h = setup();
    h.enqueue();
    h.setShell(null);
    expect(h.run).not.toHaveBeenCalled();
    expect(h.onDropped).toHaveBeenCalledOnce();
  });

  it("runs at once when the run ended before the choice was made", () => {
    const h = setup("completed");
    h.enqueue();
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.queued()).toBeNull();
  });

  it("does nothing after a cancel", () => {
    const h = setup();
    h.enqueue();
    h.queue.cancel(REF);
    expect(h.queued()).toBeNull();
    h.setShell(shellWith("completed"));
    expect(h.run).not.toHaveBeenCalled();
    expect(h.onDropped).not.toHaveBeenCalled();
  });

  it("keeps only the latest action for a thread", () => {
    const h = setup();
    const first = vi.fn();
    h.queue.enqueue(REF, { action: "commit", run: first, onDropped: h.onDropped });
    h.queue.enqueue(REF, { action: "commit_push", run: h.run, onDropped: h.onDropped });
    expect(h.queued()).toBe("commit_push");
    h.setShell(shellWith("completed"));
    expect(first).not.toHaveBeenCalled();
    expect(h.run).toHaveBeenCalledOnce();
  });
});
