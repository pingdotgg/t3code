import { assert, describe, it } from "@effect/vitest";

import { createClerkOAuthCancel } from "./clerkOAuthCancel.ts";

const deferredOpen = () => {
  const resolvers: Array<(value: { callbackUrl: string }) => void> = [];
  const opened: Array<Promise<{ callbackUrl: string }>> = [];
  const open = (_url: string) => {
    const promise = new Promise<{ callbackUrl: string }>((resolve) => {
      resolvers.push(resolve);
    });
    opened.push(promise);
    return promise;
  };
  return { open, resolvers, opened };
};

const outcome = (promise: Promise<{ callbackUrl: string }>) =>
  promise.then(
    ({ callbackUrl }) => `resolved ${callbackUrl}`,
    (error: Error) => `rejected ${error.message}`,
  );

describe("createClerkOAuthCancel", () => {
  it("cancel rejects the pending flow and reports it is no longer pending", async () => {
    const oauth = createClerkOAuthCancel();
    const changes: boolean[] = [];
    oauth.onPendingChange((pending) => changes.push(pending));
    const { open } = deferredOpen();

    const flow = outcome(oauth.wrapOpen(open)("https://accounts.example/a"));
    assert.isTrue(oauth.isPending());
    oauth.cancel();

    assert.strictEqual(await flow, "rejected Clerk: OAuth flow was cancelled.");
    assert.isFalse(oauth.isPending());
    assert.deepStrictEqual(changes, [true, false]);
  });

  it("a new attempt replaces the pending one, and the old result cannot clear it", async () => {
    const oauth = createClerkOAuthCancel();
    const { open, resolvers, opened } = deferredOpen();
    const wrapped = oauth.wrapOpen(open);

    const first = outcome(wrapped("https://accounts.example/a"));
    const second = outcome(wrapped("https://accounts.example/b"));
    assert.strictEqual(await first, "rejected Clerk: OAuth flow was cancelled.");

    resolvers[0]?.({ callbackUrl: "t3code://app/?a" });
    // Two hops, so the wrapper's own `.then().finally()` on this result has run.
    await opened[0]?.then(() => undefined).then(() => undefined);
    assert.isTrue(oauth.isPending());

    resolvers[1]?.({ callbackUrl: "t3code://app/?b" });
    assert.strictEqual(await second, "resolved t3code://app/?b");
    assert.isFalse(oauth.isPending());
  });
});
