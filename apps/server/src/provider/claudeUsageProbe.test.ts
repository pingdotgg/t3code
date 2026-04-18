import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

import type { PtyAdapterShape, PtyProcess } from "../terminal/Services/PTY.ts";

class MockPtyChild implements PtyProcess {
  public readonly writes: string[] = [];
  public readonly kill = vi.fn();

  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal: number | null }) => void
  >();

  public get pid(): number {
    return 12345;
  }

  public write(data: string): void {
    this.writes.push(data);
  }

  public resize(_cols: number, _rows: number): void {
    // no-op
  }

  public onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => {
      this.dataListeners.delete(listener);
    };
  }

  public onExit(
    listener: (event: { exitCode: number; signal: number | null }) => void,
  ): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  public emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  public emitExit(): void {
    for (const listener of this.exitListeners) {
      listener({ exitCode: 0, signal: null });
    }
  }
}

function makeMockPtyAdapter(child: MockPtyChild): PtyAdapterShape {
  return {
    spawn: () => {
      child.writes.length = 0;
      child.kill.mockClear();
      return Effect.succeed(child);
    },
  };
}

import {
  parseClaudeRuntimeUsageLimits,
  parseClaudeUsageLimitsOutput,
  probeClaudeUsageLimits,
  shouldRequestClaudeUsageFallback,
} from "./claudeUsageProbe.ts";

describe("claudeUsageProbe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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

  it("returns unavailable for API key accounts when no windows found", () => {
    expect(
      parseClaudeUsageLimitsOutput({
        checkedAt: "2026-04-17T10:00:00.000Z",
        output: "Using API key for authentication",
      }),
    ).toEqual({
      source: "claudeStatusProbe",
      available: false,
      checkedAt: "2026-04-17T10:00:00.000Z",
      reason: "Usage limits unavailable for Claude API key accounts.",
      windows: [],
    });
  });

  it("parses windows even when output contains api key wording", () => {
    expect(
      parseClaudeUsageLimitsOutput({
        checkedAt: "2026-04-17T10:00:00.000Z",
        output: `
          Session usage 42% resets at 2026-04-17T14:00:00Z
          To set an API key, use: env ANTHROPIC_API_KEY=sk-...
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
      ],
    });
  });

  it("parses runtime Claude rate limit telemetry when utilization is present", () => {
    expect(
      parseClaudeRuntimeUsageLimits({
        checkedAt: "2026-04-17T10:00:00.000Z",
        rateLimits: {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: 37,
            resetsAt: 1776448800,
          },
        },
      }),
    ).toEqual({
      source: "claudeStatusProbe",
      available: true,
      checkedAt: "2026-04-17T10:00:00.000Z",
      windows: [
        {
          kind: "session",
          label: "Session",
          usedPercent: 37,
          windowDurationMins: 300,
          resetsAt: "2026-04-17T18:00:00.000Z",
        },
      ],
    });
  });

  it("ignores runtime Claude telemetry when utilization is missing", () => {
    expect(
      parseClaudeRuntimeUsageLimits({
        checkedAt: "2026-04-17T10:00:00.000Z",
        rateLimits: {
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "seven_day_opus",
            resetsAt: 1776448800,
          },
        },
      }),
    ).toBeUndefined();
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
    const child = new MockPtyChild();
    const ptyAdapter = makeMockPtyAdapter(child);
    const probePromise = Effect.runPromise(
      probeClaudeUsageLimits(
        {
          binaryPath: "claude",
          cwd: "/tmp",
          checkedAt: "2026-04-17T10:00:00.000Z",
        },
        ptyAdapter,
      ),
    );

    expect(child.writes).toEqual(["/status\r"]);

    await vi.advanceTimersByTimeAsync(150);
    expect(child.writes).toEqual(["/status\r", "/usage\r"]);

    child.emitExit();
    const result = await probePromise;
    expect(result.usageLimits.available).toBe(false);
  });

  it("triggers /usage fallback for short non-empty status output", async () => {
    const child = new MockPtyChild();
    const ptyAdapter = makeMockPtyAdapter(child);
    const probePromise = Effect.runPromise(
      probeClaudeUsageLimits(
        {
          binaryPath: "claude",
          cwd: "/tmp",
          checkedAt: "2026-04-17T10:00:00.000Z",
        },
        ptyAdapter,
      ),
    );

    child.emitData("Authenticated as Claude Max\n");

    await vi.advanceTimersByTimeAsync(150);
    expect(child.writes).toEqual(["/status\r", "/usage\r"]);

    child.emitExit();
    const result = await probePromise;
    expect(result.usageLimits.available).toBe(false);
  });

  it("skips /usage fallback when /status already returns usable quota output", async () => {
    const child = new MockPtyChild();
    const ptyAdapter = makeMockPtyAdapter(child);
    const probePromise = Effect.runPromise(
      probeClaudeUsageLimits(
        {
          binaryPath: "claude",
          cwd: "/tmp",
          checkedAt: "2026-04-17T10:00:00.000Z",
        },
        ptyAdapter,
      ),
    );

    child.emitData("Session usage 42% resets at 2026-04-17T14:00:00Z\n");

    const result = await probePromise;
    expect(result.usageLimits.available).toBe(true);
    expect(child.writes).toEqual(["/status\r"]);
  });

  it("times out cleanly when neither /status nor /usage yields usable quota data", async () => {
    const child = new MockPtyChild();
    const ptyAdapter = makeMockPtyAdapter(child);
    const probePromise = Effect.runPromise(
      probeClaudeUsageLimits(
        {
          binaryPath: "claude",
          cwd: "/tmp",
          checkedAt: "2026-04-17T10:00:00.000Z",
        },
        ptyAdapter,
      ),
    );

    await vi.advanceTimersByTimeAsync(150);
    expect(child.writes).toEqual(["/status\r", "/usage\r"]);

    await vi.advanceTimersByTimeAsync(4_000);
    const result = await probePromise;

    expect(result.usageLimits.available).toBe(false);
    expect(result.rawOutput).toBe("");
    expect(child.writes.filter((entry) => entry === "/usage\r")).toHaveLength(1);
  });
});
