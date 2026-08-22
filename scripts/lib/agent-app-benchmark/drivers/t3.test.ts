// @effect-diagnostics nodeBuiltinImport:off - Driver conformance launches only the exact executable under test.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";

import type { DriverRequest, DriverResponse } from "../contracts.ts";
import {
  parseProcessStartTime,
  runT3DriverExecutable,
  runT3DriverStdio,
  semanticTimelinePaintReady,
  warmSwitchPlan,
  type T3Driver,
  type T3DriverProcessHost,
} from "./t3.ts";

const hello = {
  protocolVersion: 1 as const,
  application: { name: "T3 Code", version: "test", build: "production-equivalent" as const },
  driver: { name: "t3-test", version: "1", digestSha256: "a".repeat(64) },
  capabilities: {
    profiles: ["workspace-core-v1" as const],
    scenarios: ["app-cold-ready-v1" as const],
    metrics: ["app.cold_ready_ms" as const],
    readinessDetection: "test",
    paintDetection: "test",
    requiredPreparation: [],
  },
};

function helloRequest(correlationId: string): DriverRequest {
  return {
    protocolVersion: 1,
    kind: "request",
    correlationId,
    method: "hello",
    params: { frameworkVersion: 1 },
  };
}

const stubDriver: T3Driver = {
  hello: async () => hello,
  prepare: async () => ({ coverage: [] }),
  launch: async () => {
    throw new Error("not used");
  },
  runScenario: async () => {
    throw new Error("not used");
  },
  shutdown: async () => ({ terminated: [], survivors: [] }),
};

it("accepts only a complete first fold containing the target thread's canonical latest turn", () => {
  const target = { expectedMessageIds: ["user-latest", "assistant-latest"] };
  const ready = {
    expectedVisibleMessageId: "assistant-latest",
    expectedVisibleMessageTextLength: 42,
    visibleSemanticMessageCount: 3,
    visibleRowIds: ["message:user-latest", "message:assistant-latest"],
    overflowPx: 2_000,
    topGapPx: 24,
  };

  assert.equal(semanticTimelinePaintReady(ready, target), true);
  assert.equal(
    semanticTimelinePaintReady({ ...ready, expectedVisibleMessageId: null }, target),
    false,
  );
  assert.equal(
    semanticTimelinePaintReady(
      {
        ...ready,
        expectedVisibleMessageId: "assistant-latest",
        expectedVisibleMessageTextLength: 0,
      },
      target,
    ),
    false,
  );
  assert.equal(semanticTimelinePaintReady({ ...ready, topGapPx: 280 }, target), false);
  assert.equal(
    semanticTimelinePaintReady(
      { ...ready, expectedVisibleMessageId: "stale-message", topGapPx: 24 },
      target,
    ),
    false,
  );
});

it("warms every work item before a seeded measured pass of real switches", () => {
  const targets = Array.from({ length: 20 }, (_, index) => ({
    sessionId: `session-${index}`,
    title: `Session ${index}`,
    expectedMessageIds: [`message-${index}`],
  }));
  const plan = warmSwitchPlan(targets, "benchmark-seed");

  assert.deepStrictEqual(plan.warmup, targets);
  assert.equal(plan.measured.length, 20);
  assert.deepStrictEqual(
    plan.measured.map((target) => target.sessionId).toSorted(),
    targets.map((target) => target.sessionId).toSorted(),
  );
  assert.notEqual(plan.measured[0]?.sessionId, plan.warmup.at(-1)?.sessionId);
});

it("normalizes the authoritative OS process start time to the monitor's second bucket", () => {
  assert.equal(
    parseProcessStartTime("Sun Aug  9 13:35:41 2026\n", 200),
    Date.parse("Sun Aug  9 13:35:41 2026"),
  );
  assert.throws(() => parseProcessStartTime("not-a-process-time", 200), /invalid start time/u);
});

it("serializes successful responses and bounded duplicate-correlation failures", async () => {
  const input = NodeStream.Readable.from(
    `${JSON.stringify(helloRequest("same"))}\n${JSON.stringify(helloRequest("same"))}\n`,
  );
  const output = new NodeStream.PassThrough();
  let serialized = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    serialized += chunk;
  });
  await runT3DriverStdio(stubDriver, input, output);
  const responses = serialized
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as DriverResponse);
  assert.equal(responses[0]?.ok, true);
  assert.equal(responses[1]?.ok, false);
  if (responses[1]?.ok === false)
    assert.match(responses[1].error.message, /Duplicate correlation ID/u);
});

it("cleans up the exact driver handles before exiting on termination", async () => {
  const input = new NodeStream.PassThrough();
  const output = new NodeStream.PassThrough();
  const listeners = new Map<"SIGINT" | "SIGTERM", () => void>();
  const exitCodes: number[] = [];
  const shutdownReasons: string[] = [];
  const lifecycle: string[] = [];
  const host: T3DriverProcessHost = {
    once: (signal, listener) => listeners.set(signal, listener),
    off: (signal, listener) => {
      if (listeners.get(signal) === listener) listeners.delete(signal);
    },
    exit: (code) => {
      lifecycle.push("exit");
      exitCodes.push(code);
    },
  };
  const driver: T3Driver = {
    ...stubDriver,
    shutdown: async ({ reason }) => {
      lifecycle.push("shutdown");
      shutdownReasons.push(reason);
      return { terminated: [], survivors: [] };
    },
  };
  const running = runT3DriverExecutable(driver, input, output, host);
  listeners.get("SIGTERM")?.();
  await Promise.resolve();
  input.end();
  await running;
  assert.deepStrictEqual(shutdownReasons, ["driver-sigterm"]);
  assert.deepStrictEqual(exitCodes, [143]);
  assert.deepStrictEqual(lifecycle, ["shutdown", "exit"]);
});

it("the default TypeScript executable always answers protocol hello", async () => {
  const testFile = NodeURL.fileURLToPath(import.meta.url);
  const entry = NodePath.join(NodePath.dirname(testFile), "t3.ts");
  const child = NodeChildProcess.spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Array<Buffer> = [];
  const stderr: Array<Buffer> = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  child.stdin.end(`${JSON.stringify(helloRequest("hello-1"))}\n`);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, Buffer.concat(stderr).toString("utf8"));
  const response = JSON.parse(Buffer.concat(stdout).toString("utf8")) as DriverResponse;
  assert.equal(response.ok, true);
  assert.equal(response.method, "hello");
  if (response.ok && response.method === "hello") {
    assert.equal(response.result.application.name, "T3 Code");
    assert.equal(response.result.protocolVersion, 1);
    assert.deepStrictEqual(response.result.capabilities.profiles, [
      "workspace-core-v1",
      "resource-core-v1",
    ]);
    assert.deepStrictEqual(response.result.capabilities.scenarios, [
      "app-cold-ready-v1",
      "work-item-cold-open-v1",
      "work-item-warm-switch-v1",
      "resource-sweep-v1",
      "resource-quiescence-v1",
    ]);
    assert.deepStrictEqual(response.result.capabilities.metrics, [
      "app.cold_ready_ms",
      "work_item.cold_open_ms",
      "work_item.warm_switch_p95_ms",
      "resource.peak_process_family_rss_mib",
      "resource.quiescent_cpu_p95_pct",
    ]);
  }
});
