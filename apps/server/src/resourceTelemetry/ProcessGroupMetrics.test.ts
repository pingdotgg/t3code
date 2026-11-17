import { assert, describe, it } from "@effect/vitest";
import type { ResourceTelemetryProcess, ResourceTelemetrySnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import * as ProcessGroupMetrics from "./ProcessGroupMetrics.ts";
import * as ResourceMonitorBinary from "./ResourceMonitorBinary.ts";
import * as ResourceTelemetry from "./ResourceTelemetry.ts";

const { groupProcesses } = ProcessGroupMetrics;

const process = (
  pid: number,
  ppid: number,
  name: string,
  category: ResourceTelemetryProcess["category"] = "server-child",
  command = name,
) =>
  ({
    identity: { pid, startTimeMs: 1 },
    ppid,
    name,
    command,
    category,
    residentBytes: pid * 1_000,
    cpuPercent: pid,
  }) as ResourceTelemetryProcess;

describe("groupProcesses", () => {
  it("sums each direct child of the server with its whole subtree", () => {
    const totals = groupProcesses([
      process(10, 1, "node", "server"),
      process(11, 10, "t3-resource-mon", "resource-monitor"),
      process(20, 10, "claude"),
      process(21, 20, "bash"),
      process(22, 21, "cargo"),
      process(30, 10, "codex"),
      process(40, 10, "zsh"),
      process(50, 10, "chrome-headless"),
      process(60, 10, "git", "server-child", "git checkout claude/fix"),
      process(70, 99, "orphan"),
      // An older Claude package runs as a script under node.
      process(
        80,
        10,
        "node",
        "server-child",
        "node /opt/node_modules/@anthropic-ai/claude-code/cli.js",
      ),
      process(90, 10, "node", "server-child", "node /srv/tools/report.js"),
    ]);

    assert.deepStrictEqual(Object.fromEntries(totals), {
      server: { residentBytes: 10_000, cpuPercent: 10, count: 1 },
      "resource-monitor": { residentBytes: 11_000, cpuPercent: 11, count: 1 },
      // The agent's shell and the build it ran belong to the agent, not the terminal group.
      claude: { residentBytes: 143_000, cpuPercent: 143, count: 4 },
      codex: { residentBytes: 30_000, cpuPercent: 30, count: 1 },
      terminal: { residentBytes: 40_000, cpuPercent: 40, count: 1 },
      browser: { residentBytes: 50_000, cpuPercent: 50, count: 1 },
      // `git` whose arguments mention claude, a parentless process, and a node script.
      other: { residentBytes: 220_000, cpuPercent: 220, count: 3 },
    });
  });
});

describe("ProcessGroupMetrics.layer", () => {
  it.effect("logs the first failed sample and the recovery, not every repeat", () => {
    const logs: Array<string> = [];
    const logger = Logger.make(({ logLevel, message }) => {
      logs.push(`${logLevel.toUpperCase()} ${String([message].flat()[0])}`);
    });
    return Effect.gen(function* () {
      const outcomes = yield* Ref.make<ReadonlyArray<"fail" | "ok">>(["fail", "fail", "ok"]);
      const refresh = Ref.modify(outcomes, ([next = "ok", ...rest]) => [next, rest] as const).pipe(
        Effect.flatMap((next) =>
          next === "fail"
            ? Effect.fail(
                new ResourceTelemetry.ResourceTelemetryRefreshFailed({
                  operation: "refresh",
                  cause: new Error("Resource monitor binary was not found for darwin/arm64."),
                }),
              )
            : Effect.succeed({ processes: [] } as unknown as ResourceTelemetrySnapshot),
        ),
      );
      const telemetry = { refresh } as unknown as ResourceTelemetry.ResourceTelemetry["Service"];

      yield* Layer.build(
        ProcessGroupMetrics.layer.pipe(
          Layer.provide(Layer.succeed(ResourceTelemetry.ResourceTelemetry, telemetry)),
          Layer.provide(
            ServerConfig.layer({
              otlpMetricsUrl: "http://localhost:4318/v1/metrics",
            } as ServerConfig.ServerConfig["Service"]),
          ),
        ),
      );
      yield* TestClock.adjust("3 minutes");

      assert.deepStrictEqual(logs, [
        "WARN process group metrics are not exported: sample failed",
        "DEBUG process group metrics sample failed",
        "INFO process group metrics sample recovered",
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          Logger.layer([logger], { mergeWithExisting: false }),
          Layer.succeed(References.MinimumLogLevel, "Debug"),
        ),
      ),
    );
  });

  it.effect("warns with the resource monitor's own failure, not its startup state", () => {
    const warnings: Array<string> = [];
    const logger = Logger.make(({ logLevel, cause }) => {
      if (logLevel === "Warn") warnings.push(Cause.pretty(cause));
    });
    const config = ServerConfig.layer({
      cwd: "/",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
    } as ServerConfig.ServerConfig["Service"]);
    const nativeClient = NativeTelemetryClient.layer.pipe(
      Layer.provide(
        Layer.succeed(ResourceMonitorBinary.ResourceMonitorBinary, {
          // The real resolver checks the filesystem, so the supervisor is still starting meanwhile.
          resolve: Effect.sleep("10 millis").pipe(
            Effect.andThen(
              Effect.fail(
                new ResourceMonitorBinary.ResourceMonitorBinaryNotFound({
                  platform: "linux",
                  architecture: "x64",
                  candidates: [],
                }),
              ),
            ),
          ),
        }),
      ),
      Layer.provide(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("spawned without a binary")),
        ),
      ),
      Layer.provide(
        Layer.succeed(
          SecureRandom.SecureRandom,
          SecureRandom.make(() => new Uint8Array(16)),
        ),
      ),
      Layer.provide(config),
    );
    return Effect.gen(function* () {
      const native = yield* NativeTelemetryClient.NativeTelemetryClient;
      const telemetry = {
        refresh: native.sampleNow.pipe(
          Effect.mapError(
            (cause) =>
              new ResourceTelemetry.ResourceTelemetryRefreshFailed({ operation: "refresh", cause }),
          ),
        ),
      } as unknown as ResourceTelemetry.ResourceTelemetry["Service"];
      yield* Layer.build(
        ProcessGroupMetrics.layer.pipe(
          Layer.provide(Layer.succeed(ResourceTelemetry.ResourceTelemetry, telemetry)),
          Layer.provide(config),
        ),
      );
      yield* TestClock.adjust("3 minutes");

      assert.strictEqual(warnings.length, 1);
      assert.include(warnings[0], "Resource monitor binary was not found for linux/x64.");
    }).pipe(
      Effect.provide(nativeClient),
      Effect.scoped,
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
  });
});
