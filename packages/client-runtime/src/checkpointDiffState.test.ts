import { EnvironmentId, ThreadId, type OrchestrationGetTurnDiffResult } from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type CheckpointDiffClient,
  createCheckpointDiffManager,
  EMPTY_CHECKPOINT_DIFF_STATE,
  getCheckpointDiffTargetKey,
} from "./checkpointDiffState.ts";

let registry = AtomRegistry.make();

function resetAtomRegistry() {
  registry.dispose();
  registry = AtomRegistry.make();
}

const TARGET = {
  environmentId: EnvironmentId.make("env-local"),
  threadId: ThreadId.make("thread-1"),
  fromTurnCount: 1,
  toTurnCount: 2,
  ignoreWhitespace: false,
};

const PATCH_RESULT: OrchestrationGetTurnDiffResult = {
  threadId: TARGET.threadId,
  diff: "patch",
  fromTurnCount: 1,
  toTurnCount: 2,
};

function createClient() {
  return {
    getTurnDiff: vi.fn(async () => PATCH_RESULT),
    getFullThreadDiff: vi.fn(async () => PATCH_RESULT),
  } satisfies CheckpointDiffClient;
}

describe("createCheckpointDiffManager", () => {
  afterEach(() => {
    resetAtomRegistry();
  });

  it("loads a turn checkpoint diff into atom state", async () => {
    const client = createClient();
    const manager = createCheckpointDiffManager({
      getRegistry: () => registry,
      getClient: () => client,
    });

    await expect(manager.load(TARGET)).resolves.toEqual(PATCH_RESULT);

    expect(client.getTurnDiff).toHaveBeenCalledWith({
      threadId: TARGET.threadId,
      fromTurnCount: 1,
      toTurnCount: 2,
      ignoreWhitespace: false,
      scope: "snapshot",
    });
    expect(client.getFullThreadDiff).not.toHaveBeenCalled();
    expect(manager.getSnapshot(TARGET)).toEqual({
      data: PATCH_RESULT,
      error: null,
      isPending: false,
    });
  });

  it("loads a full thread diff when the range starts at zero", async () => {
    const client = createClient();
    const manager = createCheckpointDiffManager({
      getRegistry: () => registry,
      getClient: () => client,
    });

    await manager.load({ ...TARGET, fromTurnCount: 0 });

    expect(client.getFullThreadDiff).toHaveBeenCalledWith({
      threadId: TARGET.threadId,
      toTurnCount: 2,
      ignoreWhitespace: false,
    });
    expect(client.getTurnDiff).not.toHaveBeenCalled();
  });

  it("returns empty state for invalid targets", () => {
    const manager = createCheckpointDiffManager({
      getRegistry: () => registry,
      getClient: () => createClient(),
    });

    expect(manager.getSnapshot({ ...TARGET, threadId: null })).toBe(EMPTY_CHECKPOINT_DIFF_STATE);
    expect(getCheckpointDiffTargetKey({ ...TARGET, threadId: null })).toBeNull();
  });

  it("deduplicates in-flight requests and reuses successful cached data", async () => {
    const client = createClient();
    const manager = createCheckpointDiffManager({
      getRegistry: () => registry,
      getClient: () => client,
    });

    const first = manager.load(TARGET);
    const second = manager.load(TARGET);

    expect(first).toBe(second);
    await first;
    await manager.load(TARGET);

    expect(client.getTurnDiff).toHaveBeenCalledTimes(1);
  });

  it("retries temporarily unavailable checkpoint diffs", async () => {
    let attempts = 0;
    const client = {
      getFullThreadDiff: vi.fn(async () => PATCH_RESULT),
      getTurnDiff: vi.fn(async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("checkpoint is unavailable for turn");
        }
        return PATCH_RESULT;
      }),
    } satisfies CheckpointDiffClient;
    const manager = createCheckpointDiffManager({
      getRegistry: () => registry,
      getClient: () => client,
      retryDelay: async () => undefined,
    });

    await expect(manager.load(TARGET)).resolves.toEqual(PATCH_RESULT);

    expect(client.getTurnDiff).toHaveBeenCalledTimes(3);
  });
});
