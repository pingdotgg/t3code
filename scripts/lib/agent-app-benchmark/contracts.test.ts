import { assert, describe, it } from "@effect/vitest";

import {
  AGENT_APP_DRIVER_PROTOCOL_VERSION,
  PRIMARY_METRIC_UNITS,
  decodeAgentAppCorpus,
  decodeDriverMessage,
  decodeRawMetricSample,
  decodeResultBundle,
  validateDriverTranscript,
} from "./contracts.ts";

const sha = "a".repeat(64);

const manifest = {
  counts: {
    sessions: 1,
    turns: 1,
    messages: 1,
    parts: 1,
    textParts: 1,
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
    renderableBytes: 5,
  },
  hashes: { corpusSha256: sha, semanticSha256: sha, terminalSha256: sha },
};

const corpus = {
  schemaVersion: 1,
  kind: "agent-app-corpus",
  corpusId: "fixture-v1",
  source: "generated-public",
  seed: "fixture-seed",
  sessions: [
    {
      id: "session-1",
      title: "Fixture",
      order: 0,
      turns: [
        {
          id: "turn-1",
          index: 0,
          anchor: "first",
          messages: [
            {
              id: "message-1",
              order: 0,
              role: "user",
              parts: [{ id: "part-1", order: 0, type: "text", text: "hello" }],
            },
          ],
        },
      ],
      events: [],
      terminalStreams: [],
    },
  ],
  manifest,
} as const;

const exactSample = {
  schemaVersion: 1,
  sampleId: "sample-1",
  attemptId: "attempt-1",
  profile: "workspace-core-v1",
  scenario: "work-item-cold-open-v1",
  metric: "work_item.cold_open_ms",
  observation: { state: "exact", value: 12.5, unit: "ms" },
  evidence: [
    {
      sequence: 0,
      name: "trusted-action-to-stable-semantic-paint",
      clockOwner: "renderer",
      clockDomain: "performance",
      resolutionMs: 0.1,
      observerMethod: "render sequence plus animation frame",
      startTimestamp: 10,
      endTimestamp: 22.5,
    },
  ],
  validity: {
    status: "valid",
    evidence: [
      {
        check: "canonical-latest-turn-stable-and-visible",
        expectedSha256: sha,
        actualSha256: sha,
        passed: true,
      },
    ],
  },
} as const;

describe("agent-app benchmark contracts", () => {
  it("decodes the complete v1 corpus and preserves all primary metric units", () => {
    assert.deepStrictEqual(decodeAgentAppCorpus(corpus), corpus);
    assert.deepStrictEqual(PRIMARY_METRIC_UNITS, {
      "app.cold_ready_ms": "ms",
      "work_item.cold_open_ms": "ms",
      "work_item.warm_switch_p95_ms": "ms",
      "resource.peak_process_family_rss_mib": "MiB",
      "resource.quiescent_cpu_p95_pct": "percent",
    });
  });

  it("accepts a capability-limited hello response without full coverage claims", () => {
    const message = decodeDriverMessage({
      protocolVersion: AGENT_APP_DRIVER_PROTOCOL_VERSION,
      kind: "response",
      correlationId: "hello-1",
      method: "hello",
      ok: true,
      result: {
        protocolVersion: AGENT_APP_DRIVER_PROTOCOL_VERSION,
        application: { name: "Terminal App", version: "1.2.3", build: "release" },
        driver: { name: "fixture-driver", version: "1.0.0", digestSha256: sha },
        capabilities: {
          profiles: ["workspace-core-v1", "resource-core-v1"],
          scenarios: ["work-item-cold-open-v1", "work-item-warm-switch-v1", "resource-sweep-v1"],
          metrics: [
            "app.cold_ready_ms",
            "work_item.cold_open_ms",
            "resource.peak_process_family_rss_mib",
            "resource.quiescent_cpu_p95_pct",
          ],
          readinessDetection: "accessible terminal focus and trusted input",
          paintDetection: "terminal model sequence followed by renderer paint",
          requiredPreparation: ["isolated profile"],
        },
      },
    });
    assert(message.kind === "response" && message.ok && message.method === "hello");
    assert.deepStrictEqual(message.result.capabilities.profiles, [
      "workspace-core-v1",
      "resource-core-v1",
    ]);
  });

  it("rejects unknown versions, metric/unit mismatches, negative values, and missing evidence", () => {
    assert.throws(() =>
      decodeDriverMessage({
        protocolVersion: 2,
        kind: "request",
        correlationId: "hello-1",
        method: "hello",
        params: { frameworkVersion: 1 },
      }),
    );
    assert.throws(() =>
      decodeRawMetricSample({
        ...exactSample,
        observation: { state: "exact", value: 12.5, unit: "MiB" },
      }),
    );
    assert.throws(() =>
      decodeRawMetricSample({
        ...exactSample,
        observation: { state: "exact", value: -1, unit: "ms" },
      }),
    );
    assert.throws(() => decodeRawMetricSample({ ...exactSample, evidence: [] }));
    assert.throws(() =>
      decodeRawMetricSample({
        ...exactSample,
        validity: {
          status: "valid",
          evidence: [{ check: "terminal-model-hash", passed: false }],
        },
      }),
    );
  });

  it("rejects duplicate correlations and non-monotonic milestones", () => {
    const request = {
      protocolVersion: 1,
      kind: "request",
      correlationId: "same-id",
      method: "hello",
      params: { frameworkVersion: 1 },
    } as const;
    assert.throws(() => validateDriverTranscript([request, request]), /duplicate correlation/u);
    assert.throws(
      () =>
        decodeRawMetricSample({
          ...exactSample,
          evidence: [
            exactSample.evidence[0],
            { ...exactSample.evidence[0], sequence: 1, startTimestamp: 9, endTimestamp: 10 },
          ],
        }),
      /monotonic/u,
    );
  });

  it("decodes a valid sample and result bundle with explicit validity evidence", () => {
    assert.deepStrictEqual(decodeRawMetricSample(exactSample), exactSample);
    const result = decodeResultBundle({
      schemaVersion: 1,
      frameworkVersion: "1.0.0",
      runId: "run-1",
      corpus: { corpusId: corpus.corpusId, digestSha256: sha },
      runProfile: "smoke",
      application: { name: "Terminal App", version: "1.2.3", build: "release" },
      driver: { name: "fixture-driver", version: "1.0.0", digestSha256: sha },
      profiles: ["workspace-core-v1"],
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
        launchFlags: [],
      },
      resourceTopology: { included: [], excluded: [], unattributed: [] },
      attempts: [
        { attemptId: "attempt-1", measured: true, samples: [exactSample], diagnostics: [] },
      ],
      statistics: [],
      limitations: ["Smoke estimates are not publishable."],
    });
    const observation = result.attempts[0]?.samples[0]?.observation;
    assert(observation?.state === "exact");
    assert.equal(observation.unit, "ms");
  });
});
