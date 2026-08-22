import { assert, describe, expect, it } from "@effect/vitest";

import {
  assertShareableArtifact,
  buildShareableLocalCorpusSummary,
  scanShareableArtifact,
} from "./privacy.ts";

const sha = "b".repeat(64);

describe("agent-app benchmark privacy", () => {
  it("builds local reports from a closed aggregate allowlist", () => {
    const summary = buildShareableLocalCorpusSummary({
      selectedSessionCount: 20,
      messageCount: 100,
      partCount: 500,
      eventCount: 1_000,
      finalRenderableBytes: 42_000,
      eventBytes: 84_000,
      sizeDistributionBytes: { minimum: 100, median: 1_000, maximum: 9_000 },
      semanticSha256: sha,
      sourceDatabasePath: "/Users/alice/.local/share/opencode/opencode.db",
      selectedSourceIds: ["secret-session-id"],
      transcriptSample: "the planted transcript phrase",
      authRows: [{ access_token: "sk-private-secret" }],
    });
    const json = JSON.stringify(summary);
    expect(json).not.toMatch(/alice|secret-session|transcript phrase|access_token|sk-private/u);
    assert.deepStrictEqual(scanShareableArtifact(summary), []);
  });

  it("detects credentials, absolute paths, URLs, sensitive keys, and planted phrases", () => {
    const findings = scanShareableArtifact(
      {
        token: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
        location: "C:\\Users\\alice\\source.txt",
        href: "https://private.example.test/attachment?id=1",
        note: "the planted transcript phrase",
      },
      { forbiddenPhrases: ["the planted transcript phrase"] },
    );
    assert(findings.some((finding) => finding.code === "sensitive-key"));
    assert(findings.some((finding) => finding.code === "credential"));
    assert(findings.some((finding) => finding.code === "absolute-path"));
    assert(findings.some((finding) => finding.code === "url"));
    assert(findings.some((finding) => finding.code === "forbidden-phrase"));
    assert.throws(
      () => assertShareableArtifact({ output: "/home/alice/private" }),
      /privacy scan/u,
    );
  });

  it("flags sensitive keys in camelCase as well as snake_case", () => {
    // Every artifact in this repo is camelCase, so underscore-only term
    // boundaries would leave the scanner effectively inert.
    const findings = scanShareableArtifact({
      promptText: "a",
      sessionTitle: "b",
      filePath: "c",
      accessToken: "d",
      toolArgs: "e",
    });
    assert.deepStrictEqual(findings.map((finding) => finding.path).toSorted(), [
      "$.accessToken",
      "$.filePath",
      "$.promptText",
      "$.sessionTitle",
      "$.toolArgs",
    ]);
  });

  it("leaves the report's own aggregate field names alone", () => {
    assert.deepStrictEqual(
      scanShareableArtifact({
        schemaVersion: 1,
        frameworkVersion: "1",
        runProfile: "quick",
        reportKind: "estimate",
        measuredSamples: 5,
        rawSamplesDigest: "sha256:abc",
        observerMethod: "two stable frames",
        clockOwner: "t3-renderer",
        clockDomain: "performance.now",
        resolutionMs: 0.1,
        logicalCoreCount: 8,
        displayRefreshHz: 120,
        colorScheme: "dark",
        reducedMotion: false,
        measurementMethods: [],
        resourceTopology: { unattributed: [] },
      }),
      [],
    );
  });
});
