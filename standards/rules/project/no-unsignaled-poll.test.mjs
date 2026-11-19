import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../lint-fixture.mjs";

const lint = createRuleFixture("project/no-unsignaled-poll");

const reported = [
  [
    "await expect.poll(() => requests.length).toBe(1);",
    "await expect.poll(() => requests.length).toBe(1);",
  ],
  [
    "await expect.poll(() => requests.length, { timeout: 5000 }).toBe(3);",
    "await expect.poll(() => requests.length, { timeout: 5000 }).toBe(3);",
  ],
  [
    "await expect.poll(() => traffic.requests.length).toBe(1);",
    "await expect.poll(() => traffic.requests.length).toBe(1);",
  ],
  [
    "await expect.poll(() => requestedChunks.size).toBeGreaterThan(0);",
    "await expect.poll(() => requestedChunks.size).toBeGreaterThan(0);",
  ],
  [
    "await expect.poll(() => { return sent.length; }).toBe(2);",
    "await expect.poll(() => { return sent.length; }).toBe(2);",
  ],
  [
    "await expect.poll(() => received).toHaveLength(1);",
    "await expect.poll(() => received).toHaveLength(1);",
  ],
  [
    "await expect.poll(() => replayUploads.uploads).toHaveLength(2);",
    "await expect.poll(() => replayUploads.uploads).toHaveLength(2);",
  ],
  [
    "await expect.poll(() => onComplete.mock.calls.length).toBe(1);",
    "await expect.poll(() => onComplete.mock.calls.length).toBe(1);",
  ],
  [
    "await expect.poll(() => reload.mock.settledResults[0]?.type).toBe('...",
    "await expect.poll(() => reload.mock.settledResults[0]?.type).toBe('rejected');",
  ],
  [
    "await expect\n  .poll(() => mutate.mock.calls.length)\n  .toBe(1);",
    "await expect\n  .poll(() => mutate.mock.calls.length)\n  .toBe(1);",
  ],
  [
    "await expect.poll(() => spy).toHaveBeenCalledTimes(1);",
    "await expect.poll(() => spy).toHaveBeenCalledTimes(1);",
  ],
  [
    "await expect.poll(() => state.post).toHaveBeenCalled();",
    "await expect.poll(() => state.post).toHaveBeenCalled();",
  ],
  [
    "await vi.waitFor(() => expect(preload).toHaveBeenCalledTimes(2));",
    "await vi.waitFor(() => expect(preload).toHaveBeenCalledTimes(2));",
  ],
  [
    "await vi.waitFor(() => expect(state.post).toHaveBeenCalledOnce());",
    "await vi.waitFor(() => expect(state.post).toHaveBeenCalledOnce());",
  ],
  [
    "await vi.waitFor(() => expect(cancel).not.toHaveBeenCalledWith(1));",
    "await vi.waitFor(() => expect(cancel).not.toHaveBeenCalledWith(1));",
  ],
  [
    "await vi.waitFor(() => expect(requests).toHaveLength(1));",
    "await vi.waitFor(() => expect(requests).toHaveLength(1));",
  ],
  [
    "await vi.waitFor(() => expect(releases.length).toBeGreaterThan(inde...",
    "await vi.waitFor(() => expect(releases.length).toBeGreaterThan(index));",
  ],
  [
    "await vi.waitFor(() => expect(cancel.mock.calls.length).toBeGreater...",
    "await vi.waitFor(() => expect(cancel.mock.calls.length).toBeGreaterThan(0));",
  ],
  [
    "await vi.waitFor(() => { expect(fetcher).toHaveBeenCalled(); });",
    "await vi.waitFor(() => { expect(fetcher).toHaveBeenCalled(); });",
  ],
  [
    "await vi.waitFor(() => workers.size, { timeout: 2000 });",
    "await vi.waitFor(() => workers.size, { timeout: 2000 });",
  ],
];

const allowed = [
  [
    "const request = Promise.withResolvers(); await request.promise;",
    "const request = Promise.withResolvers(); await request.promise;",
  ],
  [
    "await expect.poll(() => result.current.items.length).toBe(2);",
    "await expect.poll(() => result.current.items.length).toBe(2);",
  ],
  [
    "await vi.waitFor(() => expect(result.current.pendingReplies).toHave...",
    "await vi.waitFor(() => expect(result.current.pendingReplies).toHaveLength(1));",
  ],
  [
    "await expect.poll(() => curves('overlaid-area').length).toBe(3);",
    "await expect.poll(() => curves('overlaid-area').length).toBe(3);",
  ],
  [
    "await expect.poll(() => rows.elements().length).toBe(6);",
    "await expect.poll(() => rows.elements().length).toBe(6);",
  ],
  [
    "await expect.poll(() => document.title).toBe('Slack');",
    "await expect.poll(() => document.title).toBe('Slack');",
  ],
  [
    "await expect.poll(rowLabels).toStrictEqual(['a']);",
    "await expect.poll(rowLabels).toStrictEqual(['a']);",
  ],
  [
    "await expect.poll(() => entered, { timeout: 5000 }).toBe(true);",
    "await expect.poll(() => entered, { timeout: 5000 }).toBe(true);",
  ],
  [
    "await expect.poll(() => status).toStrictEqual({ ready: true });",
    "await expect.poll(() => status).toStrictEqual({ ready: true });",
  ],
  [
    "await expect.poll(() => result.current.save).toHaveBeenCalled();",
    "await expect.poll(() => result.current.save).toHaveBeenCalled();",
  ],
  [
    "await expect.poll(() => clients.at(-1)).toBeDefined();",
    "await expect.poll(() => clients.at(-1)).toBeDefined();",
  ],
  [
    "await expect.poll(() => client.isFetching()).toBe(0);",
    "await expect.poll(() => client.isFetching()).toBe(0);",
  ],
  [
    "await expect.poll(() => network.snapshot().pending.length).toBe(1);",
    "await expect.poll(() => network.snapshot().pending.length).toBe(1);",
  ],
  [
    "await vi.waitFor(() => expect(screen.getByText('Saved')).toBeVisibl...",
    "await vi.waitFor(() => expect(screen.getByText('Saved')).toBeVisible());",
  ],
  [
    "await vi.waitFor(() => expect(status).toBe('ready'));",
    "await vi.waitFor(() => expect(status).toBe('ready'));",
  ],
  [
    "await vi.waitFor(() => { const count = requests.length; expect(coun...",
    "await vi.waitFor(() => { const count = requests.length; expect(count).toBe(1); });",
  ],
  [
    "expect(requests).toHaveLength(1); expect(onComplete).toHaveBeenCall...",
    "expect(requests).toHaveLength(1); expect(onComplete).toHaveBeenCalledOnce();",
  ],
];

for (const [name, source] of reported) {
  NodeTest.test(`Given ${name}, When the rule lints it, Then it reports a finding`, () => {
    NodeAssert.ok(lint(source, "src/fixture.test.ts").length > 0);
  });
}

for (const [name, source] of allowed) {
  NodeTest.test(`Given ${name}, When the rule lints it, Then it reports nothing`, () => {
    NodeAssert.deepEqual(lint(source, "src/fixture.test.ts"), []);
  });
}
