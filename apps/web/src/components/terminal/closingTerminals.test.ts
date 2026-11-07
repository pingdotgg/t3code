import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { closingTerminalIds, holdTerminalIdWhileClosing } from "./closingTerminals";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

it("keeps a closing terminal's ID out of reach until its last close settles", async () => {
  const thread = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
  const otherThread = { ...thread, threadId: ThreadId.make("other") };
  const first = deferred();
  const second = deferred();

  const firstClose = holdTerminalIdWhileClosing(thread, "term-1", () => first.promise);
  const secondClose = holdTerminalIdWhileClosing(thread, "term-1", () => second.promise);
  expect(closingTerminalIds(thread)).toEqual(["term-1"]);
  expect(closingTerminalIds(otherThread)).toEqual([]);

  first.reject(new Error("close failed"));
  await expect(firstClose).rejects.toThrow("close failed");
  expect(closingTerminalIds(thread)).toEqual(["term-1"]);

  second.resolve();
  await secondClose;
  expect(closingTerminalIds(thread)).toEqual([]);
});
