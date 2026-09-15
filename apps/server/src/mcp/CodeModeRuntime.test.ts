import { afterEach, expect, it } from "@effect/vitest";
import type { CodeModeCall } from "@t3tools/contracts";
import { CodeModeProcess, type CodeModeInput } from "./CodeModeProcess.ts";

const pendingCall: CodeModeInput["invoke"] = async (_, __, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) resolve(null);
    else signal.addEventListener("abort", () => resolve(null), { once: true });
  });
let pool = new CodeModeProcess();
afterEach(async () => {
  await pool.dispose();
  pool = new CodeModeProcess();
});

function run(
  code: string,
  invoke: CodeModeInput["invoke"] = async () => null,
  signal = new AbortController().signal,
) {
  const calls: Array<CodeModeCall> = [];
  const logs: Array<string> = [];
  return {
    result: pool.execute({ code, invoke, signal, calls, logs, tools: ["test"] }),
    calls,
    logs,
  };
}

it("runs real JavaScript with a fresh heap and no host globals", async () => {
  const first = run(
    "globalThis.secret = 42; console.log('hello', 2); return { n: [1,2,3].reduce((a,b)=>a+b), host: [typeof process,typeof require,typeof fetch,typeof setTimeout] };",
  );
  expect(await first.result).toEqual({
    n: 6,
    host: ["undefined", "undefined", "undefined", "undefined"],
  });
  expect(first.logs).toEqual(['["hello",2]']);
  expect(await run("return typeof secret").result).toBe("undefined");
});

it("overlaps guest Promise.all calls and preserves JSON arguments and results", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seen: Array<unknown> = [];
  const execution = run(
    "return await Promise.all([t3.test({id:1}),t3.test({id:2})]);",
    async (_, args) => {
      seen.push(args);
      if (seen.length === 2) started.resolve();
      await release.promise;
      return args;
    },
  );
  await started.promise;
  expect(seen).toEqual([{ id: 1 }, { id: 2 }]);
  release.resolve();
  expect(await execution.result).toEqual(seen);
  expect(execution.calls.map((call) => call.status)).toEqual(["completed", "completed"]);
});

it("rejects failed tools with structured codes and journals caught failures", async () => {
  const execution = run(
    "try { await t3.test({}); } catch(e) { return {code:e.code,message:e.message}; }",
    async () => {
      throw { code: "capability_denied", message: "Denied" };
    },
  );
  expect(await execution.result).toEqual({ code: "capability_denied", message: "Denied" });
  expect(execution.calls[0]).toEqual({
    tool: "test",
    status: "failed",
    result: { code: "capability_denied", message: "Denied" },
  });
});

it("cancels pending calls and disposes a guest promise that never resolves", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<AbortSignal>();
  const execution = run(
    "await t3.test({}); return 1;",
    async (_, __, signal) => {
      started.resolve(signal);
      return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(null), { once: true }),
      );
    },
    controller.signal,
  );
  const signal = await started.promise;
  controller.abort();
  await expect(execution.result).rejects.toThrow("cancelled");
  expect(signal.aborted).toBe(true);
  expect(await run("return 2").result).toBe(2);
});

it("fails scripts with syntax errors, unawaited calls, or oversized output", async () => {
  await expect(run("return {").result).rejects.toBeDefined();
  await expect(run("t3.test({}); return 1;", pendingCall).result).rejects.toThrow("unawaited");
  await expect(run("return 'x'.repeat(70000)").result).rejects.toThrow("64 KiB");
});

it("interrupts an infinite loop without poisoning later executions", async () => {
  await expect(run("while(true) {}").result).rejects.toThrow("interrupted");
  expect(await run("return 3").result).toBe(3);
});

it("bounds the guest heap and call fanout", async () => {
  await expect(run("return new ArrayBuffer(32000000)").result).rejects.toThrow("out of memory");
  await expect(
    run("return await Promise.all(Array.from({length:9},()=>t3.test({})));", pendingCall).result,
  ).rejects.toThrow("8 calls");
  await expect(run("for(let i=0;i<33;i++) await t3.test({});").result).rejects.toThrow("32 calls");
  expect(await run("return 4").result).toBe(4);
});

it("bounds guest error text before returning it to the agent", async () => {
  const error: unknown = await run("throw new Error('x'.repeat(100000));").result.catch(
    (error) => error,
  );
  expect(error).toBeInstanceOf(Error);
  if (error instanceof Error) expect(error.message.length).toBeLessThanOrEqual(2_000);
});
