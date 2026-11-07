import { describe, expect, it } from "vite-plus/test";

import {
  abortComposerDraftOperations,
  startComposerDraftOperation,
} from "./composerDraftOperations";

describe("composer draft operations", () => {
  it("aborts every running operation for the draft and leaves other drafts alone", () => {
    const first = startComposerDraftOperation("thread-a");
    const second = startComposerDraftOperation("thread-a");
    const other = startComposerDraftOperation("thread-b");

    abortComposerDraftOperations("thread-a");

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    other.finish();
  });

  it("does not abort an operation that finished before the draft switched", () => {
    const finished = startComposerDraftOperation("thread-c");
    finished.finish();
    const running = startComposerDraftOperation("thread-c");

    abortComposerDraftOperations("thread-c");

    expect(finished.signal.aborted).toBe(false);
    expect(running.signal.aborted).toBe(true);
  });

  it("keeps tracking an operation started after an abort when an older one finishes", () => {
    const before = startComposerDraftOperation("thread-d");
    abortComposerDraftOperations("thread-d");
    const after = startComposerDraftOperation("thread-d");
    before.finish();
    abortComposerDraftOperations("thread-d");

    expect(after.signal.aborted).toBe(true);
  });
});
