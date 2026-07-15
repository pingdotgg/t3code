import { describe, expect, it } from "bun:test";

import {
  buildThreadCreationBootstrap,
  makeTuiClient,
  type TuiCreateThreadInput,
  type TuiRuntime,
} from "./connection.ts";
import type { ThreadId } from "@t3tools/contracts";

// A fake runtime that just counts runFork calls. Each cold warm-thread scope does
// one runFork(Effect.scoped(...)); reuse does none; eviction does one more
// (Fiber.interrupt). The follower's runFork happens inside ref.then (the ref
// promise never resolves here), so it doesn't fire synchronously — which lets us
// count warm-scope starts/evictions deterministically.
function fakeRuntime() {
  let forks = 0;
  const runtime = {
    runFork: () => {
      forks += 1;
      return { id: forks };
    },
    runPromise: async () => undefined,
    dispose: async () => {},
  } as unknown as TuiRuntime;
  return { runtime, forks: () => forks };
}

const tid = (id: string) => id as unknown as ThreadId;

describe("makeTuiClient warm thread registry", () => {
  it("Given a thread is subscribed twice, when re-selected, then it reuses the warm ref (no new scope)", () => {
    const f = fakeRuntime();
    const client = makeTuiClient(f.runtime);
    client.subscribeThread(tid("A"), () => {});
    client.subscribeThread(tid("A"), () => {}); // re-select A
    client.subscribeThread(tid("B"), () => {});
    // A started one scope, B started one — the re-select added none.
    expect(f.forks()).toBe(2);
  });

  it("Given more than the warm cap distinct threads, when exceeding it, then the LRU is evicted", () => {
    const f = fakeRuntime();
    const client = makeTuiClient(f.runtime);
    // 9 distinct threads, cap is 8 → the 9th evicts the LRU (one extra interrupt fork).
    for (let i = 0; i < 9; i++) client.subscribeThread(tid(`T${i}`), () => {});
    expect(f.forks()).toBe(10); // 9 warm scopes + 1 eviction interrupt
  });

  it("Given no data has streamed, when peeked, then peekThread is null (no crash)", () => {
    const f = fakeRuntime();
    const client = makeTuiClient(f.runtime);
    client.subscribeThread(tid("A"), () => {});
    expect(client.peekThread(tid("A"))).toBeNull();
  });
});

describe("new-thread bootstrap", () => {
  const input = {
    projectId: "p1",
    projectCwd: "/workspace/project-one",
    title: "Create safely",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    firstMessage: "Create safely",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    createWorktree: true,
    startFromOrigin: true,
  } as unknown as TuiCreateThreadInput;

  it("Given a new worktree, when building the first turn, then thread creation and worktree preparation share one bootstrap", () => {
    const bootstrap = buildThreadCreationBootstrap(
      input,
      "2026-07-15T12:00:00.000Z",
      "t3code/1234abcd",
    );

    expect(bootstrap).toMatchObject({
      createThread: {
        projectId: "p1",
        branch: "main",
        worktreePath: null,
      },
      prepareWorktree: {
        projectCwd: "/workspace/project-one",
        baseBranch: "main",
        branch: "t3code/1234abcd",
        startFromOrigin: true,
      },
      runSetupScript: true,
    });
  });

  it("Given the current workspace, when building the first turn, then no worktree is prepared", () => {
    const bootstrap = buildThreadCreationBootstrap(
      { ...input, createWorktree: false, worktreePath: "/workspace/current" },
      "2026-07-15T12:00:00.000Z",
      null,
    );

    expect(bootstrap.createThread?.worktreePath).toBe("/workspace/current");
    expect(bootstrap.prepareWorktree).toBeUndefined();
    expect(bootstrap.runSetupScript).toBeUndefined();
  });
});
