import { describe, expect, it } from "vite-plus/test";

import { pendingDraftWork } from "./pendingDraftWork";

describe("PendingDraftWork", () => {
  it("holds a draft until every transfer it started has finished", async () => {
    const pending = pendingDraftWork;
    const key = "concurrent-transfers";
    // Two pasted attachments downloading at once, the second slower than the first.
    const defer = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((settle) => {
        resolve = settle;
      });
      return { promise, resolve };
    };
    const fast = defer();
    const slow = defer();
    const transfer = async (done: Promise<void>) => {
      pending.begin(key);
      try {
        await done;
      } finally {
        pending.end(key);
      }
    };
    const both = Promise.all([transfer(fast.promise), transfer(slow.promise)]);

    expect(pending.has(key)).toBe(true);
    fast.resolve();
    await fast.promise;
    // The first finishing must not release the draft while the second is still downloading.
    expect(pending.has(key)).toBe(true);
    slow.resolve();
    await both;
    expect(pending.has(key)).toBe(false);
  });

  it("keeps one draft's work from blocking another", () => {
    const pending = pendingDraftWork;
    pending.begin("isolated-a");
    expect(pending.has("isolated-b")).toBe(false);
    pending.end("isolated-a");
    expect(pending.has("isolated-a")).toBe(false);
  });

  it("keeps a claim on the draft across a remount of the composer", async () => {
    // The composer unmounting mid-download must not release the draft: the transfer is still
    // running, and a fresh per-instance counter would read empty and let the draft send.
    const { pendingDraftWork: first } = await import("./pendingDraftWork");
    first.begin("remounted");
    const { pendingDraftWork: second } = await import("./pendingDraftWork");
    expect(second.has("remounted")).toBe(true);
    second.end("remounted");
    expect(first.has("remounted")).toBe(false);
  });

  it("does not go negative when a transfer ends twice", () => {
    const pending = pendingDraftWork;
    pending.begin("double-end");
    pending.end("double-end");
    pending.end("double-end");
    pending.begin("double-end");
    // A stray extra `end` must not leave the counter below zero, or this begin would read false.
    expect(pending.has("double-end")).toBe(true);
  });
});
