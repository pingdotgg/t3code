import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AgentSessionScanResult, resolveAgentSessionImportWindowMs } from "./agentSessions.ts";

describe("resolveAgentSessionImportWindowMs", () => {
  it("resolves 30d to 30 days in ms", () => {
    expect(resolveAgentSessionImportWindowMs("30d")).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("resolves 90d to 90 days in ms", () => {
    expect(resolveAgentSessionImportWindowMs("90d")).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("resolves 1y to 365 days in ms", () => {
    expect(resolveAgentSessionImportWindowMs("1y")).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it("resolves all to null (no cutoff)", () => {
    expect(resolveAgentSessionImportWindowMs("all")).toBeNull();
  });
});

const decodeScanResult = Schema.decodeUnknownSync(AgentSessionScanResult);

const candidate = {
  path: "/projects/repo",
  title: "repo",
  sources: ["codex"],
  threadCount: 3,
  lastActiveAt: "2026-08-20T12:00:00.000Z",
  alreadyImported: false,
} as const;

describe("AgentSessionScanResult", () => {
  it("decodes candidates from servers that predate the git scan", () => {
    const result = decodeScanResult({
      candidates: [candidate],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toBeUndefined();
  });

  it("preserves reported git identity", () => {
    const git = { remoteKey: "github.com/pingdotgg/t3code", repository: "pingdotgg/t3code" };
    const result = decodeScanResult({
      candidates: [{ ...candidate, git }],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toEqual(git);
  });
});
