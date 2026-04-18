import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Disposable = { readonly dispose: () => void };

class MockPtyChild {
  public readonly writes: string[] = [];
  public readonly kill = vi.fn();

  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<() => void>();

  public onData(listener: (data: string) => void): Disposable {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      },
    };
  }

  public onExit(listener: () => void): Disposable {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  }

  public write(data: string): void {
    this.writes.push(data);
  }

  public emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  public emitExit(): void {
    for (const listener of this.exitListeners) {
      listener();
    }
  }
}

const spawnMock = vi.fn<
  (file: string, args?: readonly string[], options?: Record<string, unknown>) => MockPtyChild
>(() => new MockPtyChild());

vi.mock("node-pty", () => ({
  spawn: spawnMock,
}));

import {
  parseClaudeUsageLimitsOutput,
  probeClaudeUsageLimits,
  shouldRequestClaudeUsageFallback,
} from "./claudeUsageProbe.ts";

async function latestSpawnedChild(): Promise<MockPtyChild> {
  // Wait for dynamic import to resolve and spawn to be called
  await vi.waitFor(() => {
    if (!spawnMock.mock.results.at(-1)?.value) {
      throw new Error("Expected node-pty spawn to be called.");
    }
  });
  return spawnMock.mock.results.at(-1)?.value!;
}

describe("claudeUsageProbe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses session and weekly windows from status output", () => {
    expect(
      parseClaudeUsageLimitsOutput({
        checkedAt: "2026-04-17T10:00:00.000Z",
        output: `
          Session usage 42% resets at 2026-04-17T14:00:00Z
          Weekly usage 68% resets at 2026-04-21T00:00:00Z
        `,
      }),
    ).toEqual({
      source: "claudeStatusProbe",
      available: true,
      checkedAt: "2026-04-17T10:00:00.000Z",
      windows: [
        {
          kind: "session",
          label: "Session",
          usedPercent: 42,
          windowDurationMins: 300,
          resetsAt: "2026-04-17T14:00:00.000Z",
        },
        {
          kind: "weekly",
          label: "Weekly",
          usedPercent: 68,
          windowDurationMins: 10080,
          resetsAt: "2026-04-21T00:00:00.000Z",
        },
      ],
    });
  });

  it("returns unavailable when quota text is absent", () => {
    expect(
      parseClaudeUsageLimitsOutput({
        checkedAt: "2026-04-17T10:00:00.000Z",
        output: "Authenticated as Claude Max",
      }),
    ).toEqual({
      source: "claudeStatusProbe",
      available: false,
      checkedAt: "2026-04-17T10:00:00.000Z",
      reason: "Usage limits unavailable for this Claude account.",
      windows: [],
    });
  });

  it("requests the /usage fallback for short unavailable status output", () => {
    expect(
      shouldRequestClaudeUsageFallback({
        checkedAt: "2026-04-17T10:00:00.000Z",
        output: "Authenticated as Claude Max\n",
      }),
    ).toBe(true);
  });

  it("requests the /usage fallback even when output is empty", () => {
    expect(
      shouldRequestClaudeUsageFallback({
        checkedAt: "2026-04-17T10:00:00.000Z",
        output: "",
      }),
    ).toBe(true);
  });

  it("skips the /usage fallback once usage windows are already available", () => {
    expect(
      shouldRequestClaudeUsageFallback({
        checkedAt: "2026-04-17T10:00:00.000Z",
        output: "Session usage 42% resets at 2026-04-17T14:00:00Z\n",
      }),
    ).toBe(false);
  });

  it("triggers /usage fallback when /status remains quiet", async () => {
    const probePromise = probeClaudeUsageLimits({
      binaryPath: "claude",
      cwd: "/tmp",
      checkedAt: "2026-04-17T10:00:00.000Z",
    });

    const child = await latestSpawnedChild();
    expect(child.writes).toEqual(["/status\r"]);

    await vi.advanceTimersByTimeAsync(150);
    expect(child.writes).toEqual(["/status\r", "/usage\r"]);

    child.emitExit();
    const result = await probePromise;
    expect(result.usageLimits.available).toBe(false);
  });

  it("triggers /usage fallback for short non-empty status output", async () => {
    const probePromise = probeClaudeUsageLimits({
      binaryPath: "claude",
      cwd: "/tmp",
      checkedAt: "2026-04-17T10:00:00.000Z",
    });

    const child = await latestSpawnedChild();
    child.emitData("Authenticated as Claude Max\n");

    await vi.advanceTimersByTimeAsync(150);
    expect(child.writes).toEqual(["/status\r", "/usage\r"]);

    child.emitExit();
    const result = await probePromise;
    expect(result.usageLimits.available).toBe(false);
  });

  it("skips /usage fallback when /status already returns usable quota output", async () => {
    const probePromise = probeClaudeUsageLimits({
      binaryPath: "claude",
      cwd: "/tmp",
      checkedAt: "2026-04-17T10:00:00.000Z",
    });

    const child = await latestSpawnedChild();
    child.emitData("Session usage 42% resets at 2026-04-17T14:00:00Z\n");

    const result = await probePromise;
    expect(result.usageLimits.available).toBe(true);
    expect(child.writes).toEqual(["/status\r"]);
  });

  it("times out cleanly when neither /status nor /usage yields usable quota data", async () => {
    const probePromise = probeClaudeUsageLimits({
      binaryPath: "claude",
      cwd: "/tmp",
      checkedAt: "2026-04-17T10:00:00.000Z",
    });

    const child = await latestSpawnedChild();
    await vi.advanceTimersByTimeAsync(150);
    expect(child.writes).toEqual(["/status\r", "/usage\r"]);

    await vi.advanceTimersByTimeAsync(4_000);
    const result = await probePromise;

    expect(result.usageLimits.available).toBe(false);
    expect(result.rawOutput).toBe("");
    expect(child.writes.filter((entry) => entry === "/usage\r")).toHaveLength(1);
  });
});
