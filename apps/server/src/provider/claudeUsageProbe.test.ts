import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

import * as PtyAdapter from "../terminal/PtyAdapter.ts";

import {
  parseClaudeRuntimeUsageLimits,
  parseClaudeUsageLimitsOutput,
  probeClaudeUsageLimits,
  shouldRequestClaudeUsageFallback,
  type ProbeClock,
} from "./claudeUsageProbe.ts";

class MockPtyChild implements PtyAdapter.PtyProcess {
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

function makeMockPtyAdapter(child: MockPtyChild): PtyAdapter.PtyAdapter["Service"] {
  return {
    spawn: () => Effect.succeed(child),
  };
}

function makeCapturingPtyAdapter(input: {
  readonly child: MockPtyChild;
  readonly onSpawn: (spawnInput: PtyAdapter.PtySpawnInput) => void;
}): PtyAdapter.PtyAdapter["Service"] {
  return {
    spawn: (spawnInput) => {
      input.onSpawn(spawnInput);
      return Effect.succeed(input.child);
    },
  };
}

function createFakeClock(): ProbeClock & { advance(ms: number): void } {
  const timers: Array<{
    id: number;
    ms: number;
    fn: () => void;
    fired: boolean;
    cancelled: boolean;
  }> = [];
  let nextId = 1;

  const fakeSetTimeout = ((fn: () => void, ms?: number) => {
    const id = nextId++;
    timers.push({
      id,
      ms: ms ?? 0,
      fn,
      fired: false,
      cancelled: false,
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  const fakeClearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    const numericId = typeof id === "number" ? id : (id as unknown as number);
    const entry = timers.find((t) => t.id === numericId);
    if (entry) {
      entry.cancelled = true;
    }
  }) as typeof clearTimeout;

  const advance = (ms: number) => {
    for (const timer of timers) {
      if (timer.fired || timer.cancelled) continue;
      timer.ms -= ms;
      if (timer.ms <= 0) {
        timer.fired = true;
        timer.fn();
      }
    }
  };

  return {
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    advance,
  };
}

describe("claudeUsageProbe", () => {
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

  it("resolves immediately when /status returns usable quota output", async () => {
    const child = new MockPtyChild();
    const ptyAdapter = makeMockPtyAdapter(child);
    const clock = createFakeClock();

    const probePromise = Effect.runPromise(
      probeClaudeUsageLimits(
        {
          binaryPath: "claude",
          cwd: "/tmp",
          checkedAt: "2026-04-17T10:00:00.000Z",
        },
        ptyAdapter,
        clock,
      ),
    );

    expect(child.writes).toEqual(["/status\r"]);

    child.emitData("Session usage 42% resets at 2026-04-17T14:00:00Z\n");

    const result = await probePromise;
    expect(result.usageLimits.available).toBe(true);
    expect(child.writes).toEqual(["/status\r"]);
    expect(child.kill).toHaveBeenCalled();
  });

  it("sends /usage fallback when /status output is not enough", async () => {
    const child = new MockPtyChild();
    const ptyAdapter = makeMockPtyAdapter(child);
    const clock = createFakeClock();

    const probePromise = Effect.runPromise(
      probeClaudeUsageLimits(
        {
          binaryPath: "claude",
          cwd: "/tmp",
          checkedAt: "2026-04-17T10:00:00.000Z",
        },
        ptyAdapter,
        clock,
      ),
    );

    expect(child.writes).toEqual(["/status\r"]);

    child.emitData("Authenticated as Claude Max\n");
    clock.advance(200);
    expect(child.writes).toEqual(["/status\r", "/usage\r"]);

    child.emitData("Session usage 55% resets at 2026-04-17T15:00:00Z\n");
    const result = await probePromise;
    expect(result.usageLimits.available).toBe(true);
    expect(child.kill).toHaveBeenCalled();
  });

  it("resolves unavailable when process exits with no usable data", async () => {
    const child = new MockPtyChild();
    const ptyAdapter = makeMockPtyAdapter(child);
    const clock = createFakeClock();

    const probePromise = Effect.runPromise(
      probeClaudeUsageLimits(
        {
          binaryPath: "claude",
          cwd: "/tmp",
          checkedAt: "2026-04-17T10:00:00.000Z",
        },
        ptyAdapter,
        clock,
      ),
    );

    expect(child.writes).toEqual(["/status\r"]);

    child.emitData("Authenticated as Claude Max\n");
    clock.advance(200);
    expect(child.writes).toEqual(["/status\r", "/usage\r"]);

    child.emitExit();
    const result = await probePromise;
    expect(result.usageLimits.available).toBe(false);
    expect(child.kill).toHaveBeenCalled();
  });

  it("resolves unavailable on timeout with no usable data", async () => {
    const child = new MockPtyChild();
    const ptyAdapter = makeMockPtyAdapter(child);
    const clock = createFakeClock();

    const probePromise = Effect.runPromise(
      probeClaudeUsageLimits(
        {
          binaryPath: "claude",
          cwd: "/tmp",
          checkedAt: "2026-04-17T10:00:00.000Z",
        },
        ptyAdapter,
        clock,
      ),
    );

    clock.advance(200);
    expect(child.writes).toEqual(["/status\r", "/usage\r"]);

    clock.advance(4_000);
    const result = await probePromise;

    expect(result.usageLimits.available).toBe(false);
    expect(result.rawOutput).toBe("");
    expect(child.writes.filter((entry) => entry === "/usage\r")).toHaveLength(1);
    expect(child.kill).toHaveBeenCalled();
  });

  it("returns unavailable result when spawn fails", async () => {
    const failingAdapter: PtyAdapter.PtyAdapter["Service"] = {
      spawn: () =>
        Effect.fail(
          new PtyAdapter.PtySpawnError({
            adapter: "mock",
            cause: new Error("spawn failed"),
          }),
        ),
    };

    const result = await Effect.runPromise(
      probeClaudeUsageLimits(
        {
          binaryPath: "claude",
          cwd: "/tmp",
          checkedAt: "2026-04-17T10:00:00.000Z",
        },
        failingAdapter,
      ),
    );

    expect(result.usageLimits.available).toBe(false);
    expect(result.usageLimits.reason).toBe("Failed to spawn Claude process for usage probe.");
    expect(result.rawOutput).toBe("");
  });

  it("preserves quoted launch arguments when spawning the probe process", async () => {
    const child = new MockPtyChild();
    let capturedSpawnInput: PtyAdapter.PtySpawnInput | undefined;
    const ptyAdapter = makeCapturingPtyAdapter({
      child,
      onSpawn: (spawnInput) => {
        capturedSpawnInput = spawnInput;
      },
    });

    const probePromise = Effect.runPromise(
      probeClaudeUsageLimits(
        {
          binaryPath: "claude",
          launchArgs: '--model "claude sonnet" --cwd "/tmp/with spaces" --note "say \\"hi\\""',
          cwd: "/tmp",
          checkedAt: "2026-04-17T10:00:00.000Z",
        },
        ptyAdapter,
      ),
    );

    child.emitExit();
    await probePromise;

    expect(capturedSpawnInput?.args).toEqual([
      "--model",
      "claude sonnet",
      "--cwd",
      "/tmp/with spaces",
      "--note",
      'say "hi"',
      "--permission-mode",
      "plan",
    ]);
  });
});
