import { assert, describe, it } from "@effect/vitest";

import {
  buildBenchmarkReport,
  buildBenchmarkReportFromResultBundle,
  canonicalJson,
  renderBenchmarkMarkdown,
  sha256Digest,
  type ReportSample,
} from "./report.ts";
import type { AgentAppResultBundle } from "./contracts.ts";

const exactSample = (runIndex: number, value: number): ReportSample => ({
  attemptId: `attempt-${runIndex}`,
  appId: "t3",
  profileId: "workspace-core-v1",
  scenarioId: "app-cold-ready-v1",
  phase: "measured" as const,
  runIndex,
  metricId: "app.cold_ready_ms",
  unit: "ms" as const,
  observation: { state: "exact" as const, value },
  valid: true,
  failures: [],
});

describe("agent app benchmark reports", () => {
  it("builds deterministic statistics and digests from immutable raw samples", () => {
    const input = {
      runProfile: "smoke" as const,
      frameworkVersion: 1 as const,
      seed: 31,
      samples: [exactSample(0, 100), exactSample(1, 110), exactSample(2, 90)],
    };
    const first = buildBenchmarkReport(input);
    const second = buildBenchmarkReport(input);
    assert.deepStrictEqual(first, second);
    assert.equal(first.metrics[0]?.median, 100);
    assert.equal(first.rankable, true);
    assert.equal(first.reportKind, "estimate");
    assert.match(first.rawSamplesDigest, /^sha256:[0-9a-f]{64}$/);
  });

  it("keeps bounded and unsupported observations distinct from fabricated zeroes", () => {
    const report = buildBenchmarkReport({
      runProfile: "quick",
      frameworkVersion: 1,
      seed: 3,
      samples: [
        {
          ...exactSample(0, 10),
          metricId: "work_item.cold_open_ms",
          observation: { state: "bounded", upperBound: 16 },
        },
        {
          ...exactSample(1, 10),
          metricId: "resource.quiescent_cpu_p95_pct",
          unit: "percent",
          observation: { state: "unsupported", reason: "Long Animation Frame API unavailable" },
        },
      ],
    });
    const interaction = report.metrics.find(
      (metric) => metric.metricId === "work_item.cold_open_ms",
    );
    const blockedFrames = report.metrics.find(
      (metric) => metric.metricId === "resource.quiescent_cpu_p95_pct",
    );
    assert.equal(interaction?.observationState, "bounded");
    assert.equal(interaction?.upperBound, 16);
    assert.equal(blockedFrames?.observationState, "unsupported");
  });

  it("makes the complete publication attempt unrankable when one sample is invalid", () => {
    const samples = Array.from({ length: 20 }, (_, index) => exactSample(index, 100 + index));
    samples[7] = {
      ...samples[7]!,
      valid: false,
      failures: [{ code: "coverage-mismatch", message: "Final semantic hash differed." }],
    };
    const report = buildBenchmarkReport({
      runProfile: "publication",
      frameworkVersion: 1,
      seed: 5,
      samples,
    });
    assert.equal(report.rankable, false);
    assert.equal(report.invalidMeasuredSamples, 1);
  });

  it("keeps valid metrics rankable when a different metric is unsupported", () => {
    const report = buildBenchmarkReport({
      runProfile: "smoke",
      frameworkVersion: 1,
      seed: 5,
      samples: [
        exactSample(0, 80),
        exactSample(1, 81),
        exactSample(2, 82),
        {
          ...exactSample(3, 0),
          metricId: "resource.quiescent_cpu_p95_pct",
          scenarioId: "resource-quiescence-v1",
          unit: "percent",
          observation: { state: "unsupported", reason: "LoAF unavailable" },
        },
      ],
    });
    assert.equal(report.rankable, true);
    assert.equal(
      report.metrics.find((metric) => metric.metricId === "app.cold_ready_ms")?.rankable,
      true,
    );
    assert.equal(
      report.metrics.find((metric) => metric.metricId === "resource.quiescent_cpu_p95_pct")
        ?.rankable,
      false,
    );
  });

  it("renders metric-specific tables with limitations and no composite score", () => {
    const markdown = renderBenchmarkMarkdown(
      buildBenchmarkReport({
        runProfile: "smoke",
        frameworkVersion: 1,
        seed: 1,
        samples: [exactSample(0, 88), exactSample(1, 92), exactSample(2, 90)],
      }),
    );
    assert.match(markdown, /non-publishable estimate/i);
    assert.match(markdown, /app\.cold_ready_ms/);
    assert.match(markdown, /Limitations/);
    assert.ok(!/overall score|composite score/iu.test(markdown));
  });

  it("builds a reviewable report from the canonical result bundle", () => {
    const digest = "a".repeat(64);
    const exactEvidence = {
      sequence: 0,
      name: "ready-after-paint",
      clockOwner: "renderer",
      clockDomain: "performance",
      resolutionMs: 0.1,
      observerMethod: "semantic target plus two animation frames",
      startTimestamp: 10,
      endTimestamp: 98,
    } as const;
    const bundle: AgentAppResultBundle = {
      schemaVersion: 1,
      frameworkVersion: "1.0.0",
      runId: "run-reviewable",
      corpus: { corpusId: "core-v1", digestSha256: digest },
      runProfile: "smoke",
      application: {
        name: "T3 Code",
        version: "0.12.0",
        build: "release",
        sourceCommit: "app-commit",
      },
      driver: {
        name: "t3-reference-driver",
        version: "1.0.0",
        digestSha256: "b".repeat(64),
        sourceCommit: "driver-commit",
      },
      profiles: ["workspace-core-v1", "resource-core-v1"],
      environment: {
        capturedAt: "2026-08-09T00:00:00.000Z",
        os: "macOS 26",
        architecture: "arm64",
        cpuModel: "Apple M4",
        logicalCoreCount: 10,
        physicalMemoryBytes: 16_000_000_000,
        displayRefreshHz: 60,
        displayScale: 2,
        powerSource: "ac",
        thermalState: "nominal",
        window: { width: 1440, height: 900 },
        colorScheme: "dark",
        reducedMotion: true,
        launchFlags: ["--fixture-mode"],
      },
      resourceTopology: {
        included: [{ pid: 101, startTimeMs: 1_000, owner: "application", category: "renderer" }],
        excluded: [{ pid: 202, startTimeMs: 2_000, owner: "harness", category: "observer" }],
        unattributed: [
          { pid: 303, startTimeMs: 3_000, owner: "application", category: "unknown-helper" },
        ],
      },
      attempts: [
        {
          attemptId: "attempt-ready",
          measured: true,
          diagnostics: [],
          samples: [
            {
              schemaVersion: 1,
              sampleId: "sample-ready",
              attemptId: "attempt-ready",
              profile: "workspace-core-v1",
              scenario: "app-cold-ready-v1",
              metric: "app.cold_ready_ms",
              observation: { state: "exact", value: 88, unit: "ms" },
              evidence: [exactEvidence],
              validity: {
                status: "valid",
                evidence: [{ check: "surface-ready", passed: true }],
              },
            },
          ],
        },
        {
          attemptId: "attempt-quiescence",
          measured: true,
          diagnostics: [],
          samples: [
            {
              schemaVersion: 1,
              sampleId: "sample-quiescence",
              attemptId: "attempt-quiescence",
              profile: "resource-core-v1",
              scenario: "resource-quiescence-v1",
              metric: "resource.quiescent_cpu_p95_pct",
              observation: { state: "invalid", reason: "Quiescent CPU window was not sampled." },
              evidence: [
                {
                  ...exactEvidence,
                  name: "quiescence-window",
                  observerMethod: "runner-owned process-family sampling window",
                },
              ],
              validity: {
                status: "invalid",
                evidence: [{ check: "resource-cadence", passed: false }],
                failures: [
                  {
                    code: "resource-window-mismatch",
                    message: "The quiescent CPU window was not sampled cleanly.",
                    evidence: [{ check: "resource-cadence", passed: false }],
                  },
                ],
              },
            },
          ],
        },
      ],
      statistics: [],
      limitations: ["Resource monitor sampling is unavailable in this Electron build."],
    };

    const report = buildBenchmarkReportFromResultBundle(bundle);
    const markdown = renderBenchmarkMarkdown(report);

    assert.deepStrictEqual(report.corpus, bundle.corpus);
    assert.deepStrictEqual(report.application, bundle.application);
    assert.deepStrictEqual(report.driver, bundle.driver);
    assert.deepStrictEqual(report.profiles, bundle.profiles);
    assert.deepStrictEqual(report.scenarios, ["app-cold-ready-v1", "resource-quiescence-v1"]);
    assert.equal(report.measurementMethods.length, 2);
    assert.equal(report.failedAttempts[0]?.failures[0]?.code, "resource-window-mismatch");
    assert.match(markdown, /Corpus: `core-v1`/);
    assert.match(markdown, /T3 Code/);
    assert.match(markdown, /t3-reference-driver/);
    assert.match(markdown, /Apple M4/);
    assert.match(markdown, /workspace-core-v1/);
    assert.match(markdown, /resource-quiescence-v1/);
    assert.match(markdown, /semantic target plus two animation frames/);
    assert.match(markdown, /resource-window-mismatch/);
    assert.match(markdown, /unknown-helper/);
    assert.match(markdown, /Resource monitor sampling is unavailable/);
    assert.ok(!/overall score|composite score/iu.test(markdown));
  });

  it("canonicalizes object key order before hashing", () => {
    assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
    assert.equal(sha256Digest({ b: 2, a: 1 }), sha256Digest({ a: 1, b: 2 }));
  });
});
