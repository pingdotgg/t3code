import { describe, expect, it } from "vite-plus/test";

import { pendingDraftWork } from "./pendingDraftWork";

describe("PendingDraftWork", () => {
  it("holds a draft until every transfer it started has finished", async () => {
    const pending = pendingDraftWork;
    const key = "concurrent-transfers";
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
    expect(pending.has(key)).toBe(true);
    slow.resolve();
    await both;
    expect(pending.has(key)).toBe(false);
  });

  it("does not go negative when a transfer ends twice", () => {
    const pending = pendingDraftWork;
    pending.begin("double-end");
    pending.end("double-end");
    pending.end("double-end");
    pending.begin("double-end");
    expect(pending.has("double-end")).toBe(true);
  });
});
