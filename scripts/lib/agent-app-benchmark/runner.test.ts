// @effect-diagnostics nodeBuiltinImport:off - integration-tests an owned executable driver.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  buildRunSchedule,
  DriverProcess,
  pairResourceScenarios,
  runBenchmarkAttempt,
  runProfileCounts,
  type BenchmarkDriverHandle,
  type BenchmarkInterruptSignal,
  writeIncompleteArtifact,
} from "./runner.ts";

describe("agent app benchmark runner", () => {
  it("keeps warm-ups separate from measured samples", () => {
    assert.deepStrictEqual(runProfileCounts("smoke"), { warmups: 1, measured: 3 });
    assert.deepStrictEqual(runProfileCounts("quick"), { warmups: 1, measured: 5 });
    assert.deepStrictEqual(runProfileCounts("publication"), { warmups: 3, measured: 20 });
  });

  it("builds a deterministic interleaved app/scenario schedule", () => {
    const input = {
      appIds: ["t3", "comparison"],
      scenarioIds: ["cold-ready", "warm-switch"],
      runProfile: "smoke" as const,
      seed: 812,
    };
    const first = buildRunSchedule(input);
    const second = buildRunSchedule(input);
    assert.deepStrictEqual(first, second);
    assert.equal(first.filter((entry) => entry.phase === "warmup").length, 4);
    assert.equal(first.filter((entry) => entry.phase === "measured").length, 12);
  });

  it("keeps each resource sweep and its quiescence window in one adjacent pair", () => {
    const paired = pairResourceScenarios(
      buildRunSchedule({
        appIds: ["t3"],
        scenarioIds: ["app-cold-ready-v1", "resource-quiescence-v1", "resource-sweep-v1"],
        runProfile: "smoke",
        seed: 812,
      }),
    );
    for (const [index, entry] of paired.entries()) {
      if (entry.scenarioId !== "resource-sweep-v1") continue;
      const next = paired[index + 1];
      assert.equal(next?.scenarioId, "resource-quiescence-v1");
      assert.equal(next?.phase, entry.phase);
      assert.equal(next?.runIndex, entry.runIndex);
    }
  });

  it("talks to a fake NDJSON executable and shuts down the exact child", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bench-driver-"));
    const driverPath = NodePath.join(directory, "fake-driver.mjs");
    await NodeFSP.writeFile(
      driverPath,
      [
        'import { createInterface } from "node:readline";',
        "const lines = createInterface({ input: process.stdin });",
        'lines.on("line", (line) => {',
        "  const request = JSON.parse(line);",
        '  const result = request.method === "hello"',
        '    ? { protocolVersion: 1, application: { name: "Fake", version: "1", build: "release" }, driver: { name: "fake-driver", version: "1", digestSha256: "a".repeat(64) }, capabilities: { profiles: ["workspace-core-v1"], scenarios: ["app-cold-ready-v1"], metrics: ["app.cold_ready_ms"], readinessDetection: "semantic fixture", paintDetection: "two animation frames", requiredPreparation: [] } }',
        "    : { terminated: [], survivors: [] };",
        '  process.stdout.write(JSON.stringify({ protocolVersion: 1, kind: "response", correlationId: request.correlationId, method: request.method, ok: true, result }) + "\\n");',
        '  if (request.method === "shutdown") process.exit(0);',
        "});",
      ].join("\n"),
    );

    const driver = await DriverProcess.spawn({ command: process.execPath, args: [driverPath] });
    const hello = await driver.request("hello", { frameworkVersion: 1 });
    assert.equal((hello as { application: { name: string } }).application.name, "Fake");
    await driver.request("shutdown", { reason: "test-complete" });
    await driver.close();
    assert.equal(driver.isRunning(), false);
  });

  it("writes typed incomplete artifacts for interrupted attempts", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bench-run-"));
    const output = await writeIncompleteArtifact(directory, {
      attemptId: "attempt-1",
      stage: "driver-output",
      code: "partial-driver-output",
      message: "Driver exited before returning a complete response.",
    });
    const parsed = JSON.parse(await NodeFSP.readFile(output, "utf8")) as {
      status: string;
      failure: { code: string };
    };
    assert.equal(parsed.status, "incomplete");
    assert.equal(parsed.failure.code, "partial-driver-output");
  });

  for (const interruptSignal of ["SIGINT", "SIGTERM"] as const) {
    it(`handles ${interruptSignal} through exact captured process handles`, async () => {
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bench-signal-"));
      const outputDirectory = NodePath.join(directory, "artifacts");
      const corpusDigest = "b".repeat(64);
      const semanticDigest = "c".repeat(64);
      const terminalDigest = "d".repeat(64);
      const counts = {
        sessions: 20,
        turns: 1,
        messages: 2,
        parts: 2,
        textParts: 2,
        markdownParts: 0,
        codeParts: 0,
        tableParts: 0,
        diffParts: 0,
        toolParts: 0,
        reasoningParts: 0,
        attachments: 0,
        lifecycleEvents: 0,
        terminalStreams: 0,
        terminalBytes: 0,
        renderableBytes: 10,
      };
      const appRoot = {
        pid: 4_321,
        startTimeMs: 12_345,
        owner: "application" as const,
        category: "fake-app",
      };
      const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
      let closeCount = 0;
      let interrupt: ((signal: BenchmarkInterruptSignal) => void) | undefined;
      const driver: BenchmarkDriverHandle = {
        pid: 1_234,
        isRunning: () => true,
        async request(method, params) {
          requests.push({ method, params });
          switch (method) {
            case "hello":
              return {
                protocolVersion: 1,
                application: { name: "Fake", version: "1", build: "release" },
                driver: {
                  name: "fake-driver",
                  version: "1",
                  digestSha256: "a".repeat(64),
                },
                capabilities: {
                  profiles: ["workspace-core-v1"],
                  scenarios: ["app-cold-ready-v1"],
                  metrics: ["app.cold_ready_ms"],
                  readinessDetection: "semantic fixture",
                  paintDetection: "two animation frames",
                  requiredPreparation: [],
                },
              };
            case "prepare":
              return {
                coverage: [
                  {
                    profile: "workspace-core-v1",
                    corpusDigestSha256: corpusDigest,
                    counts,
                    semanticSha256: semanticDigest,
                    passed: true,
                    unsupportedShapes: [],
                  },
                ],
              };
            case "launch":
              return {
                processes: [appRoot],
                automationReady: true,
                readinessEvidence: "ready",
              };
            case "run-scenario":
              assert.isDefined(interrupt);
              interrupt(interruptSignal);
              return new Promise<never>(() => undefined);
            case "shutdown":
              return { terminated: [appRoot], survivors: [] };
          }
        },
        async close() {
          closeCount += 1;
        },
      };

      let rejection: unknown;
      try {
        await runBenchmarkAttempt(
          {
            driver: { id: "fake", command: "unused-by-injected-driver" },
            corpusPath: NodePath.join(directory, "corpus.json"),
            corpusId: "core-v1",
            corpusDigestSha256: corpusDigest,
            corpusManifest: {
              counts,
              hashes: {
                corpusSha256: corpusDigest,
                semanticSha256: semanticDigest,
                terminalSha256: terminalDigest,
              },
            },
            outputDirectory,
            profiles: ["workspace-core-v1"],
            scenarios: ["app-cold-ready-v1"],
            runProfile: "smoke",
            seed: 11,
            environment: {
              capturedAt: "2026-08-09T00:00:00.000Z",
              os: "test-os",
              architecture: "arm64",
              cpuModel: "fixture-cpu",
              logicalCoreCount: 8,
              physicalMemoryBytes: 16_000_000_000,
              displayRefreshHz: 60,
              displayScale: 1,
              powerSource: "ac",
              thermalState: "nominal",
              window: { width: 1440, height: 900 },
              colorScheme: "dark",
              reducedMotion: true,
              launchFlags: [],
            },
          },
          {
            spawnDriver: async () => driver,
            subscribeToInterrupts: (listener) => {
              interrupt = listener;
              return () => {
                interrupt = undefined;
              };
            },
          },
        );
      } catch (cause) {
        rejection = cause;
      }
      if (!(rejection instanceof Error)) throw new Error("Expected the benchmark to reject.");
      assert.match(rejection.message, new RegExp(`Benchmark interrupted by ${interruptSignal}`));

      assert.equal(closeCount, 1);
      const shutdowns = requests.filter(({ method }) => method === "shutdown");
      assert.equal(shutdowns.length, 1);
      assert.deepStrictEqual(shutdowns[0]?.params, { reason: "benchmark-failed" });
      const [attemptName] = await NodeFSP.readdir(outputDirectory);
      assert.isDefined(attemptName);
      const artifact = JSON.parse(
        await NodeFSP.readFile(NodePath.join(outputDirectory, attemptName, "run.json"), "utf8"),
      ) as {
        readonly status: string;
        readonly failure: {
          readonly stage: string;
          readonly code: string;
          readonly message: string;
        };
      };
      assert.equal(artifact.status, "incomplete");
      assert.equal(artifact.failure.stage, "interrupted");
      assert.equal(artifact.failure.code, "benchmark-interrupted");
      assert.match(artifact.failure.message, new RegExp(interruptSignal));
    });
  }

  it("runs a complete smoke attempt through the fake executable driver", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bench-smoke-"));
    const driverPath = NodePath.join(directory, "smoke-driver.mjs");
    const lifecycleLog = NodePath.join(directory, "lifecycle.ndjson");
    const digest = "b".repeat(64);
    const semanticDigest = "c".repeat(64);
    const terminalDigest = "d".repeat(64);
    const counts = {
      sessions: 20,
      turns: 1,
      messages: 2,
      parts: 2,
      textParts: 2,
      markdownParts: 0,
      codeParts: 0,
      tableParts: 0,
      diffParts: 0,
      toolParts: 0,
      reasoningParts: 0,
      attachments: 0,
      lifecycleEvents: 0,
      terminalStreams: 0,
      terminalBytes: 0,
      renderableBytes: 10,
    };
    await NodeFSP.writeFile(
      driverPath,
      [
        'import { appendFileSync } from "node:fs";',
        'import { createInterface } from "node:readline";',
        "const lines = createInterface({ input: process.stdin });",
        "const counts = { sessions: 20, turns: 1, messages: 2, parts: 2, textParts: 2, markdownParts: 0, codeParts: 0, tableParts: 0, diffParts: 0, toolParts: 0, reasoningParts: 0, attachments: 0, lifecycleEvents: 0, terminalStreams: 0, terminalBytes: 0, renderableBytes: 10 };",
        'lines.on("line", (line) => {',
        " const request = JSON.parse(line); let result;",
        ' appendFileSync(process.env.BENCH_LIFECYCLE_LOG, JSON.stringify({ method: request.method, params: request.params }) + "\\n");',
        ' if (request.method === "hello") result = { protocolVersion: 1, application: { name: "Fake", version: "1", build: "release" }, driver: { name: "fake-driver", version: "1", digestSha256: "a".repeat(64) }, capabilities: { profiles: ["workspace-core-v1"], scenarios: ["app-cold-ready-v1"], metrics: ["app.cold_ready_ms"], readinessDetection: "semantic surface", paintDetection: "two animation frames", requiredPreparation: [] } };',
        ` else if (request.method === "prepare") result = { coverage: [{ profile: "workspace-core-v1", corpusDigestSha256: "${digest}", counts, semanticSha256: "${semanticDigest}", passed: true, unsupportedShapes: [] }] };`,
        ' else if (request.method === "launch") result = { processes: [{ pid: process.pid, startTimeMs: 1, owner: "application", category: "fake" }], automationReady: true, readinessEvidence: "ready" };',
        ' else if (request.method === "run-scenario") { const at = Number(request.params.attemptId.split("-").at(-1)); result = { samples: [{ schemaVersion: 1, sampleId: `sample-${request.params.attemptId}`, attemptId: request.params.attemptId, profile: request.params.profile, scenario: request.params.scenario, metric: "app.cold_ready_ms", observation: { state: "exact", value: 80 + at, unit: "ms" }, evidence: [{ sequence: 0, name: "ready", clockOwner: "driver", clockDomain: "monotonic", resolutionMs: 0.1, observerMethod: "fake monotonic mark", startTimestamp: at, endTimestamp: at + 80 }], validity: { status: "valid", evidence: [{ check: "surface-ready", passed: true }] } }] }; }',
        " else result = { terminated: [], survivors: [] };",
        ' process.stdout.write(JSON.stringify({ protocolVersion: 1, kind: "response", correlationId: request.correlationId, method: request.method, ok: true, result }) + "\\n");',
        "});",
      ].join("\n"),
    );
    const result = await runBenchmarkAttempt({
      driver: {
        id: "fake",
        command: process.execPath,
        args: [driverPath],
        env: { ...process.env, BENCH_LIFECYCLE_LOG: lifecycleLog },
      },
      corpusPath: NodePath.join(directory, "corpus.json"),
      corpusId: "core-v1",
      corpusDigestSha256: digest,
      corpusManifest: {
        counts,
        hashes: {
          corpusSha256: digest,
          semanticSha256: semanticDigest,
          terminalSha256: terminalDigest,
        },
      },
      outputDirectory: NodePath.join(directory, "artifacts"),
      profiles: ["workspace-core-v1"],
      scenarios: ["app-cold-ready-v1"],
      runProfile: "smoke",
      seed: 11,
      environment: {
        capturedAt: "2026-08-09T00:00:00.000Z",
        os: "test-os",
        architecture: "arm64",
        cpuModel: "fixture-cpu",
        logicalCoreCount: 8,
        physicalMemoryBytes: 16_000_000_000,
        displayRefreshHz: 60,
        displayScale: 1,
        powerSource: "ac",
        thermalState: "nominal",
        window: { width: 1440, height: 900 },
        colorScheme: "dark",
        reducedMotion: true,
        launchFlags: [],
      },
    });
    assert.equal(result.report.rankable, true);
    assert.equal(result.report.metrics[0]?.measuredSamples, 3);
    assert.match(await NodeFSP.readFile(result.reportPath, "utf8"), /app\.cold_ready_ms/);
    const run = JSON.parse(
      await NodeFSP.readFile(NodePath.join(result.attemptDirectory, "run.json"), "utf8"),
    ) as {
      readonly processes: ReadonlyArray<unknown>;
      readonly artifactDigests: Readonly<Record<string, string>>;
    };
    assert.equal(run.processes.length, 4);
    for (const [artifact, fileName] of Object.entries({
      coverage: "coverage.json",
      environment: "environment.json",
      samples: "samples.ndjson",
      result: "result.json",
      report: "report.md",
    })) {
      const bytes = await NodeFSP.readFile(NodePath.join(result.attemptDirectory, fileName));
      assert.equal(
        run.artifactDigests[artifact],
        NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      );
    }
    const lifecycle = (await NodeFSP.readFile(lifecycleLog, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly method: string;
            readonly params: {
              readonly runDirectory?: string;
              readonly isolatedProfilePath?: string;
            };
          },
      );
    assert.equal(lifecycle.filter(({ method }) => method === "prepare").length, 4);
    assert.equal(lifecycle.filter(({ method }) => method === "launch").length, 4);
    assert.equal(lifecycle.filter(({ method }) => method === "shutdown").length, 4);
    assert.equal(new Set(lifecycle.flatMap(({ params }) => params.runDirectory ?? [])).size, 4);
    assert.equal(
      new Set(lifecycle.flatMap(({ params }) => params.isolatedProfilePath ?? [])).size,
      4,
    );
  });
});
