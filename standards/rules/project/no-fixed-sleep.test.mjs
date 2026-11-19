import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../lint-fixture.mjs";

const lint = createRuleFixture("project/no-fixed-sleep");

const reported = [
  [
    "test('x', async () => { await new Promise((resolve) => { setTimeout...",
    "test('x', async () => { await new Promise((resolve) => { setTimeout(resolve, 250); }); });",
  ],
  [
    "test('x', async () => { await new Promise((resolve) => setTimeout(r...",
    "test('x', async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });",
  ],
  [
    "test('x', async () => { await new Promise<void>((done) => globalThi...",
    "test('x', async () => { await new Promise<void>((done) => globalThis.setTimeout(() => done(), 31_000)); });",
  ],
  [
    "it('x', async () => { await new Promise((resolve) => window.setTime...",
    "it('x', async () => { await new Promise((resolve) => window.setTimeout(resolve, 600)); });",
  ],
  [
    'import { setTimeout as sleep } from "node:timers/promises"; test("x...',
    'import { setTimeout as sleep } from "node:timers/promises"; test("x", async () => { await sleep(500); });',
  ],
  [
    'import { setTimeout } from "timers/promises"; afterEach(async () =>...',
    'import { setTimeout } from "timers/promises"; afterEach(async () => { await setTimeout(20); });',
  ],
  [
    "beforeEach(async () => { await scheduler.wait(10); });",
    "beforeEach(async () => { await scheduler.wait(10); });",
  ],
  [
    "test('x', async () => { await Bun.sleep(100); });",
    "test('x', async () => { await Bun.sleep(100); });",
  ],
  [
    "test.each([1])('x %s', async () => { await scheduler.wait(1); });",
    "test.each([1])('x %s', async () => { await scheduler.wait(1); });",
  ],
  [
    "test.concurrent('x', async () => { await scheduler.wait(1); });",
    "test.concurrent('x', async () => { await scheduler.wait(1); });",
  ],
  [
    "it.skipIf(ci)('x', async function () { await scheduler.wait(1); });",
    "it.skipIf(ci)('x', async function () { await scheduler.wait(1); });",
  ],
  [
    "test('x', async () => { await new Promise((resolve) => setTimeout((...",
    "test('x', async () => { await new Promise((resolve) => setTimeout(() => { resolve(); }, 100)); });",
  ],
  [
    "test('x', async () => { await new Promise((resolve) => setTimeout(f...",
    "test('x', async () => { await new Promise((resolve) => setTimeout(function () { resolve(); }, 100)); });",
  ],
  [
    "it('x', async () => { await act(async () => { release(); await new ...",
    "it('x', async () => { await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 50)); }); });",
  ],
  [
    "it('x', () => act(async () => { await scheduler.wait(1); }));",
    "it('x', () => act(async () => { await scheduler.wait(1); }));",
  ],
  [
    "test('x', async () => { await React.act(async () => { await act(asy...",
    "test('x', async () => { await React.act(async () => { await act(async () => { await scheduler.wait(1); }); }); });",
  ],
  [
    "test('x', async () => { await waitFor(async () => { await scheduler...",
    "test('x', async () => { await waitFor(async () => { await scheduler.wait(1); expect(ready).toBe(true); }); });",
  ],
  [
    "test('x', async () => { await load().then(async () => { await Bun.s...",
    "test('x', async () => { await load().then(async () => { await Bun.sleep(5); }); });",
  ],
  [
    "beforeEach(() => load().catch(async () => { await scheduler.wait(1)...",
    "beforeEach(() => load().catch(async () => { await scheduler.wait(1); }));",
  ],
  [
    "afterEach(() => load().finally(async () => { await scheduler.wait(1...",
    "afterEach(() => load().finally(async () => { await scheduler.wait(1); }));",
  ],
  [
    "test('x', async () => { await act(() => load().then(async () => { a...",
    "test('x', async () => { await act(() => load().then(async () => { await scheduler.wait(1); })); });",
  ],
  [
    "test('x', async () => { await test.step('open', async () => { await...",
    "test('x', async () => { await test.step('open', async () => { await scheduler.wait(1); }); });",
  ],
];

const allowed = [
  [
    "test('x', async () => { await operation(); });",
    "test('x', async () => { await operation(); });",
  ],
  [
    "test('x', async () => { const ready = Promise.withResolvers(); awai...",
    "test('x', async () => { const ready = Promise.withResolvers(); await ready.promise; });",
  ],
  [
    "test('x', async () => { vi.useFakeTimers(); await new Promise((reso...",
    "test('x', async () => { vi.useFakeTimers(); await new Promise((resolve) => { setTimeout(resolve, 250); }); });",
  ],
  [
    "test('x', async () => { serve(async () => { await scheduler.wait(10...",
    "test('x', async () => { serve(async () => { await scheduler.wait(10); return new Response(); }); });",
  ],
  [
    "async function backoff(attempt) { await scheduler.wait(2 ** attempt...",
    "async function backoff(attempt) { await scheduler.wait(2 ** attempt); } test('x', async () => { await backoff(1); });",
  ],
  [
    "test('x', async () => { await Promise.race([work, new Promise((reso...",
    "test('x', async () => { await Promise.race([work, new Promise((resolve) => { setTimeout(() => resolve('pending'), 0); })]); });",
  ],
  [
    "test('x', async () => { await new Promise((resolve) => { setTimeout...",
    "test('x', async () => { await new Promise((resolve) => { setTimeout(resolve, 10); queueMicrotask(resolve); }); });",
  ],
  [
    "test('x', async () => { await new Promise((resolve) => { emitter.on...",
    "test('x', async () => { await new Promise((resolve) => { emitter.once('done', resolve); }); });",
  ],
  [
    'import { setImmediate } from "node:timers/promises"; test("x", asyn...',
    'import { setImmediate } from "node:timers/promises"; test("x", async () => { await setImmediate(); });',
  ],
  [
    "test('x', async () => { const timer = setTimeout(cancel, 10); await...",
    "test('x', async () => { const timer = setTimeout(cancel, 10); await work(); clearTimeout(timer); });",
  ],
  [
    "test('x', async ({ page }) => { await page.route(url, async (route)...",
    "test('x', async ({ page }) => { await page.route(url, async (route) => { await scheduler.wait(300); await route.fulfill({ status: 200 }); }); });",
  ],
  [
    "test('x', async () => { await server.listen(async () => { await sch...",
    "test('x', async () => { await server.listen(async () => { await scheduler.wait(10); }); });",
  ],
  [
    "beforeEach(async () => { await run(async () => { await scheduler.wa...",
    "beforeEach(async () => { await run(async () => { await scheduler.wait(10); }); });",
  ],
  [
    "test('x', async () => { await act(async () => { serve(async () => {...",
    "test('x', async () => { await act(async () => { serve(async () => { await scheduler.wait(10); return new Response(); }); }); });",
  ],
  [
    "async function settle() { await act(async () => { await scheduler.w...",
    "async function settle() { await act(async () => { await scheduler.wait(1); }); } test('x', async () => { await settle(); });",
  ],
  [
    "act(async () => { await scheduler.wait(1); });",
    "act(async () => { await scheduler.wait(1); });",
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
