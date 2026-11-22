import {
  EnvironmentId,
  SandboxId,
  type CloudSandboxRecord,
  type SandboxProviderAvailability,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSandboxSpawnInput,
  formatSandboxAgentHarness,
  formatSandboxRuntimeDuration,
  getSandboxProviderAvailability,
  isVercelRuntimeWarningActive,
  resolveDefaultSandboxProvider,
  resolveSandboxRowActions,
  resolveSandboxStatusBadge,
  sortCloudSandboxes,
} from "./CloudSandboxes.logic";

function makeSandbox(overrides: Partial<CloudSandboxRecord> = {}): CloudSandboxRecord {
  return {
    id: SandboxId.make("sbx-1"),
    provider: "codesandbox",
    providerSandboxId: "csb-123",
    name: "kbcode-codesandbox-1234",
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

describe("CloudSandboxes.logic", () => {
  it("maps sandbox states to user-facing status badges", () => {
    expect(resolveSandboxStatusBadge("creating")).toEqual({
      label: "Booting",
      tone: "info",
    });
    expect(resolveSandboxStatusBadge("bootstrapping")).toEqual({
      label: "Booting",
      tone: "info",
    });
    expect(resolveSandboxStatusBadge("running")).toEqual({
      label: "Ready",
      tone: "success",
    });
    expect(resolveSandboxStatusBadge("paused")).toEqual({
      label: "Sleeping",
      tone: "secondary",
    });
    expect(resolveSandboxStatusBadge("stopped")).toEqual({
      label: "Sleeping",
      tone: "secondary",
    });
    expect(resolveSandboxStatusBadge("snapshotting")).toEqual({
      label: "Snapshotting",
      tone: "warning",
    });
    expect(resolveSandboxStatusBadge("error")).toEqual({
      label: "Error",
      tone: "error",
    });
  });

  it("formats active and paused runtime durations cleanly", () => {
    const startMs = Date.parse("2026-11-22T12:00:00.000Z");
    const running = makeSandbox({ state: "running", startedAt: "2026-11-22T12:00:00.000Z" });

    expect(formatSandboxRuntimeDuration(running, startMs + 20_000)).toBe("<1m");
    expect(formatSandboxRuntimeDuration(running, startMs + 14 * 60_000)).toBe("14m");
    expect(formatSandboxRuntimeDuration(running, startMs + 60 * 60_000)).toBe("1h");
    expect(formatSandboxRuntimeDuration(running, startMs + 95 * 60_000)).toBe("1h 35m");

    const paused = makeSandbox({
      state: "paused",
      startedAt: "2026-11-22T12:00:00.000Z",
      pausedAt: "2026-11-22T12:22:00.000Z",
    });
    expect(formatSandboxRuntimeDuration(paused, startMs + 120 * 60_000)).toBe("22m");

    const unstarted = makeSandbox({ state: "stopped", startedAt: null, pausedAt: null });
    expect(formatSandboxRuntimeDuration(unstarted, startMs + 10_000)).toBeNull();
  });

  it("detects Vercel 40-minute continuous runtime warning", () => {
    const startMs = Date.parse("2026-11-22T12:00:00.000Z");
    const vercel = makeSandbox({
      provider: "vercel-sandbox",
      state: "running",
      startedAt: "2026-11-22T12:00:00.000Z",
    });

    expect(isVercelRuntimeWarningActive(vercel, startMs + 39 * 60_000)).toBe(false);
    expect(isVercelRuntimeWarningActive(vercel, startMs + 40 * 60_000)).toBe(true);
    expect(
      isVercelRuntimeWarningActive(
        makeSandbox({ provider: "codesandbox", state: "running" }),
        startMs + 50 * 60_000,
      ),
    ).toBe(false);
    expect(
      isVercelRuntimeWarningActive(
        makeSandbox({
          provider: "vercel-sandbox",
          state: "running",
          vercelWarnedAt: "2026-11-22T12:40:00.000Z",
        }),
        startMs + 5 * 60_000,
      ),
    ).toBe(true);
  });

  it("computes allowed row actions per sandbox state and busy flag", () => {
    expect(resolveSandboxRowActions("running", false)).toEqual({
      canWake: false,
      canSnapshot: true,
      canSleep: true,
      canDestroy: true,
      isTransitional: false,
    });
    expect(resolveSandboxRowActions("paused", false)).toEqual({
      canWake: true,
      canSnapshot: true,
      canSleep: false,
      canDestroy: true,
      isTransitional: false,
    });
    expect(resolveSandboxRowActions("bootstrapping", false)).toEqual({
      canWake: false,
      canSnapshot: false,
      canSleep: true,
      canDestroy: true,
      isTransitional: true,
    });
    expect(resolveSandboxRowActions("running", true)).toEqual({
      canWake: false,
      canSnapshot: false,
      canSleep: false,
      canDestroy: false,
      isTransitional: false,
    });
  });

  it("selects default configured provider and looks up availability", () => {
    const providers: SandboxProviderAvailability[] = [
      {
        provider: "codesandbox",
        configured: false,
        defaultSnapshotId: null,
        reason: "Missing token",
      },
      { provider: "upstash-box", configured: true, defaultSnapshotId: "snap-base" },
      { provider: "vercel-sandbox", configured: false, defaultSnapshotId: null },
    ];

    expect(resolveDefaultSandboxProvider(providers)).toBe("upstash-box");
    expect(getSandboxProviderAvailability(providers, "upstash-box").defaultSnapshotId).toBe(
      "snap-base",
    );
    expect(resolveDefaultSandboxProvider([])).toBe("codesandbox");
  });

  it("validates and builds spawn inputs cleanly", () => {
    const providers: SandboxProviderAvailability[] = [
      { provider: "codesandbox", configured: true, defaultSnapshotId: null },
      {
        provider: "upstash-box",
        configured: false,
        defaultSnapshotId: null,
        reason: "UPSTASH_BOX_API_KEY is not set",
      },
    ];

    expect(
      buildSandboxSpawnInput(
        {
          provider: "upstash-box",
          name: "",
          repoUrl: "",
          branch: "",
          agentHarness: "primeAgent",
          snapshotId: "",
          idleTimeoutMinutes: "8",
        },
        { providers, defaultIdleTimeoutMinutes: 8 },
      ),
    ).toEqual({
      ok: false,
      error: "UPSTASH_BOX_API_KEY is not set",
    });

    expect(
      buildSandboxSpawnInput(
        {
          provider: "codesandbox",
          name: "",
          repoUrl: "not-a-repo-url",
          branch: "",
          agentHarness: "primeAgent",
          snapshotId: "",
          idleTimeoutMinutes: "8",
        },
        { providers, defaultIdleTimeoutMinutes: 8 },
      ),
    ).toEqual({
      ok: false,
      error: "Enter a valid repository URL (https://, ssh://, or git@).",
    });

    expect(
      buildSandboxSpawnInput(
        {
          provider: "codesandbox",
          name: "",
          repoUrl: "",
          branch: "",
          agentHarness: "primeAgent",
          snapshotId: "",
          idleTimeoutMinutes: "0",
        },
        { providers, defaultIdleTimeoutMinutes: 8 },
      ),
    ).toEqual({
      ok: false,
      error: "Auto-hibernate idle timeout must be between 1 and 1440 minutes.",
    });

    expect(
      buildSandboxSpawnInput(
        {
          provider: "codesandbox",
          name: "  my-box  ",
          repoUrl: "  https://github.com/acme/repo.git  ",
          branch: "  feat/cloud  ",
          agentHarness: "primeAgent",
          snapshotId: "  snap-42 ",
          idleTimeoutMinutes: "12",
        },
        { providers, defaultIdleTimeoutMinutes: 8 },
      ),
    ).toEqual({
      ok: true,
      input: {
        provider: "codesandbox",
        name: "my-box",
        repoUrl: "https://github.com/acme/repo.git",
        branch: "feat/cloud",
        agentHarness: "primeAgent",
        snapshotId: "snap-42",
        idleTimeoutMinutes: 12,
      },
    });

    expect(
      buildSandboxSpawnInput(
        {
          provider: "codesandbox",
          name: "",
          repoUrl: "",
          branch: "",
          agentHarness: "",
          snapshotId: "",
          idleTimeoutMinutes: "",
        },
        { providers, defaultIdleTimeoutMinutes: 8 },
      ),
    ).toEqual({
      ok: true,
      input: {
        provider: "codesandbox",
        idleTimeoutMinutes: 8,
      },
    });
  });

  it("sorts active sandboxes before sleeping and errored ones", () => {
    const sleeping = makeSandbox({
      id: SandboxId.make("sbx-sleep"),
      state: "paused",
      updatedAt: "2026-11-22T12:30:00.000Z",
    });
    const runningOlder = makeSandbox({
      id: SandboxId.make("sbx-run-old"),
      state: "running",
      environmentId: EnvironmentId.make("env-1"),
      updatedAt: "2026-11-22T12:10:00.000Z",
    });
    const runningNewer = makeSandbox({
      id: SandboxId.make("sbx-run-new"),
      state: "running",
      updatedAt: "2026-11-22T12:20:00.000Z",
    });
    const errored = makeSandbox({
      id: SandboxId.make("sbx-err"),
      state: "error",
      updatedAt: "2026-11-22T12:40:00.000Z",
    });

    expect(
      sortCloudSandboxes([errored, sleeping, runningOlder, runningNewer]).map((s) => s.id),
    ).toEqual(["sbx-run-new", "sbx-run-old", "sbx-sleep", "sbx-err"]);
  });

  it("formats agent harness labels cleanly", () => {
    expect(formatSandboxAgentHarness("primeAgent")).toBe("Prime Agent");
    expect(formatSandboxAgentHarness("claude")).toBe("Claude Code");
    expect(formatSandboxAgentHarness("claude-code")).toBe("Claude Code");
    expect(formatSandboxAgentHarness("codex")).toBe("Codex");
    expect(formatSandboxAgentHarness("opencode")).toBe("OpenCode");
    expect(formatSandboxAgentHarness("custom-agent")).toBe("custom-agent");
    expect(formatSandboxAgentHarness(null)).toBeNull();
  });
});
