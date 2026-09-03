import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { threadCommandConcurrency, threadPinCommandConcurrency } from "./threadCommands.ts";
import { createAtomCommandScheduler } from "./runtime.ts";

const target = {
  environmentId: EnvironmentId.make("environment-1"),
  input: { threadId: ThreadId.make("thread-1") },
};

describe("thread command concurrency", () => {
  it("lets pinning dispatch while first-turn worktree bootstrap is still running", async () => {
    const scheduler = createAtomCommandScheduler();
    const registry = AtomRegistry.make();
    let finishWorktree: (() => void) | undefined;
    const worktreeReady = new Promise<void>((resolve) => {
      finishWorktree = resolve;
    });
    let pinDispatched = false;
    const bootstrapTurnTarget = {
      ...target,
      input: {
        ...target.input,
        bootstrap: { prepareWorktree: {} },
      },
    };

    const bootstrap = scheduler.schedule(
      registry,
      threadCommandConcurrency,
      bootstrapTurnTarget,
      async () => {
        await worktreeReady;
        return AsyncResult.success(undefined);
      },
    );
    const pin = scheduler.schedule(registry, threadPinCommandConcurrency, target, async () => {
      pinDispatched = true;
      return AsyncResult.success(undefined);
    });

    await pin;
    expect(pinDispatched).toBe(true);
    finishWorktree?.();
    await bootstrap;
    registry.dispose();
  });

  it("keeps destructive commands serialized behind worktree bootstrap", async () => {
    const scheduler = createAtomCommandScheduler();
    const registry = AtomRegistry.make();
    let finishWorktree: (() => void) | undefined;
    const worktreeReady = new Promise<void>((resolve) => {
      finishWorktree = resolve;
    });
    let deleteDispatched = false;

    const bootstrap = scheduler.schedule(registry, threadCommandConcurrency, target, async () => {
      await worktreeReady;
      return AsyncResult.success(undefined);
    });
    const deleteThread = scheduler.schedule(
      registry,
      threadCommandConcurrency,
      target,
      async () => {
        deleteDispatched = true;
        return AsyncResult.success(undefined);
      },
    );

    await Promise.resolve();
    expect(deleteDispatched).toBe(false);
    finishWorktree?.();
    await Promise.all([bootstrap, deleteThread]);
    expect(deleteDispatched).toBe(true);
    registry.dispose();
  });
});
