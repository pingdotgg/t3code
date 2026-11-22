import { SandboxId, type CloudSandboxRecord } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSandboxSpawnInput,
  formatSandboxRuntimeDuration,
  resolveSandboxRowActions,
  resolveSandboxStatusBadge,
  sortCloudSandboxes,
} from "./cloudSandboxes.logic";

function makeSandbox(overrides: Partial<CloudSandboxRecord> = {}): CloudSandboxRecord {
  return {
    id: SandboxId.make("sbx-mobile-1"),
    provider: "upstash-box",
    providerSandboxId: "up-1",
    name: "kbcode-upstash-box-1",
    snapshotId: null,
    baseSnapshotId: null,
    repoUrl: null,
    branch: null,
    agentHarness: "primeAgent",
    connectionUrl: null,
    environmentId: null,
    state: "running",
    idleTimeoutMinutes: 8,
    startedAt: "2026-11-22T12:00:00.000Z",
    lastActivityAt: "2026-11-22T12:05:00.000Z",
    pausedAt: null,
    vercelWarnedAt: null,
    lastError: null,
    createdAt: "2026-11-22T12:00:00.000Z",
    updatedAt: "2026-11-22T12:05:00.000Z",
    ...overrides,
  };
}

describe("cloudSandboxes.logic (mobile)", () => {
  it("maps mobile badge tones and status labels", () => {
    expect(resolveSandboxStatusBadge("creating")).toEqual({
      label: "Booting",
      tone: "info",
    });
    expect(resolveSandboxStatusBadge("running")).toEqual({
      label: "Ready",
      tone: "success",
    });
    expect(resolveSandboxStatusBadge("paused")).toEqual({
      label: "Sleeping",
      tone: "muted",
    });
    expect(resolveSandboxStatusBadge("snapshotting")).toEqual({
      label: "Snapshotting",
      tone: "warning",
    });
    expect(resolveSandboxStatusBadge("error")).toEqual({
      label: "Error",
      tone: "danger",
    });
  });

  it("sorts and formats mobile sandbox records without mutating input", () => {
    const startMs = Date.parse("2026-11-22T12:00:00.000Z");
    const paused = makeSandbox({ id: SandboxId.make("sbx-paused"), state: "paused" });
    const running = makeSandbox({ id: SandboxId.make("sbx-running"), state: "running" });
    const input = [paused, running];

    expect(sortCloudSandboxes(input).map((item) => item.id)).toEqual(["sbx-running", "sbx-paused"]);
    expect(input.map((item) => item.id)).toEqual(["sbx-paused", "sbx-running"]);
    expect(formatSandboxRuntimeDuration(running, startMs + 8 * 60_000)).toBe("8m");
    expect(resolveSandboxRowActions("stopped", false).canWake).toBe(true);
  });

  it("builds mobile spawn input with default idle timeout", () => {
    expect(
      buildSandboxSpawnInput(
        {
          provider: "vercel-sandbox",
          name: "",
          repoUrl: "https://github.com/acme/mobile.git",
          branch: "main",
          agentHarness: "primeAgent",
          snapshotId: "",
          idleTimeoutMinutes: "",
        },
        { providers: [], defaultIdleTimeoutMinutes: 8 },
      ),
    ).toEqual({
      ok: true,
      input: {
        provider: "vercel-sandbox",
        repoUrl: "https://github.com/acme/mobile.git",
        branch: "main",
        agentHarness: "primeAgent",
        idleTimeoutMinutes: 8,
      },
    });
  });
});
