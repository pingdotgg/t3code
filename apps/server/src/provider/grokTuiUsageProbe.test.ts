import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as PtyAdapter from "../terminal/PtyAdapter.ts";

import {
  parseGrokUsageLimitsOutput,
  probeGrokUsageLimits,
  type ProbeClock,
} from "./grokTuiUsageProbe.ts";

class MockPtyChild implements PtyAdapter.PtyProcess {
  public readonly writes: string[] = [];
  public killed = false;
  public onWrite: ((data: string) => void) | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();

  public get pid(): number {
    return 12345;
  }

  public write(data: string): void {
    this.writes.push(data);
    this.onWrite?.(data);
  }

  public kill(): void {
    this.killed = true;
  }

  public resize(): void {
    // no-op
  }

  public onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  public onExit(listener: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  public emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

function createFakeClock(): ProbeClock & { advance(ms: number): void } {
  const timers: Array<{ id: number; ms: number; fn: () => void; cancelled: boolean }> = [];
  let nextId = 1;
  const setTimeout = ((fn: () => void, ms?: number) => {
    const id = nextId++;
    timers.push({ id, ms: ms ?? 0, fn, cancelled: false });
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;
  const clearTimeout = ((id: ReturnType<typeof globalThis.setTimeout>) => {
    const timer = timers.find((entry) => entry.id === (id as unknown as number));
    if (timer) timer.cancelled = true;
  }) as typeof globalThis.clearTimeout;

  return {
    setTimeout,
    clearTimeout,
    advance(ms) {
      for (const timer of timers) {
        if (timer.cancelled) continue;
        timer.ms -= ms;
        if (timer.ms <= 0) {
          timer.cancelled = true;
          timer.fn();
        }
      }
    },
  };
}

describe("grokTuiUsageProbe", () => {
  it("parses weekly limit and next reset from Grok /usage show output", () => {
    const checkedAt = "2026-07-07T12:00:00.000Z";
    const parsed = parseGrokUsageLimitsOutput({
      checkedAt,
      output: `
        Usage
        Show    Manage
        Weekly limit: 32%
        Next reset: July 11, 02:10 PT
      `,
    });

    expect(parsed.available).toBe(true);
    expect(parsed.source).toBe("grokStatusProbe");
    expect(parsed.windows).toHaveLength(1);
    expect(parsed.windows[0]).toMatchObject({
      kind: "weekly",
      label: "Weekly",
      usedPercent: 32,
      windowDurationMins: 7 * 24 * 60,
    });
    expect(parsed.windows[0]?.resetsAt).toBeDefined();
  });

  it("returns unavailable when weekly limit text is absent", () => {
    expect(
      parseGrokUsageLimitsOutput({
        checkedAt: "2026-07-07T12:00:00.000Z",
        output: "Show    Manage",
      }),
    ).toEqual({
      source: "grokStatusProbe",
      available: false,
      checkedAt: "2026-07-07T12:00:00.000Z",
      reason: "Could not read usage limits for this Grok account.",
      windows: [],
    });
  });

  it("uses the Pacific standard-time offset in winter", () => {
    const parsed = parseGrokUsageLimitsOutput({
      checkedAt: "2026-01-07T12:00:00.000Z",
      output: "Weekly limit: 32%\nNext reset: January 11, 02:10 PST",
    });

    expect(parsed.windows[0]?.resetsAt).toBe("2026-01-11T10:10:00.000Z");
  });

  it("rolls the reset year forward when a year-less reset wraps into next year", () => {
    const parsed = parseGrokUsageLimitsOutput({
      checkedAt: "2026-12-30T12:00:00.000Z",
      output: "Weekly limit: 90%\nNext reset: January 3, 09:00 PT",
    });

    expect(parsed.windows[0]?.resetsAt).toBe("2027-01-03T17:00:00.000Z");
  });

  it("does not roll stale same-year or explicitly dated resets forward", () => {
    const staleYearless = parseGrokUsageLimitsOutput({
      checkedAt: "2026-07-20T12:00:00.000Z",
      output: "Weekly limit: 90%\nNext reset: July 10, 09:00 PT",
    });
    const explicitYear = parseGrokUsageLimitsOutput({
      checkedAt: "2026-12-30T12:00:00.000Z",
      output: "Weekly limit: 90%\nNext reset: January 3, 2026, 09:00 PT",
    });

    expect(staleYearless.windows[0]?.resetsAt).toBe("2026-07-10T16:00:00.000Z");
    expect(explicitYear.windows[0]?.resetsAt).toBe("2026-01-03T17:00:00.000Z");
  });

  it.effect("captures synchronous output using the default probe clock", () =>
    Effect.gen(function* () {
      const child = new MockPtyChild();
      child.onWrite = () => {
        child.emitData("Weekly limit: 32%\nNext reset: July 11, 02:10 PT\n");
      };
      const ptyAdapter: PtyAdapter.PtyAdapter["Service"] = {
        spawn: () => Effect.succeed(child),
      };

      const result = yield* probeGrokUsageLimits(
        { binaryPath: "grok", cwd: "/tmp", checkedAt: "2026-07-07T12:00:00.000Z" },
        ptyAdapter,
      );

      expect(result.usageLimits.windows[0]?.resetsAt).toBe("2026-07-11T09:10:00.000Z");
      expect(child.writes).toEqual(["/usage\r"]);
      expect(child.killed).toBe(true);
    }),
  );

  it.effect("settles after utilization output when no reset line arrives", () =>
    Effect.gen(function* () {
      const child = new MockPtyChild();
      const clock = createFakeClock();
      const ptyAdapter: PtyAdapter.PtyAdapter["Service"] = {
        spawn: () => Effect.succeed(child),
      };
      const resultFiber = yield* Effect.forkChild(
        probeGrokUsageLimits(
          { binaryPath: "grok", cwd: "/tmp", checkedAt: "2026-07-07T12:00:00.000Z" },
          ptyAdapter,
          clock,
        ),
        { startImmediately: true },
      );

      child.emitData("Weekly limit: 32%\n");
      clock.advance(199);
      expect(child.killed).toBe(false);
      clock.advance(1);

      const result = yield* Fiber.join(resultFiber);
      expect(result.usageLimits).toMatchObject({ available: true });
      expect(result.usageLimits.windows[0]?.resetsAt).toBeUndefined();
      expect(child.killed).toBe(true);
    }),
  );

  it.effect("opens usage in the TUI and waits briefly for the reset line", () =>
    Effect.gen(function* () {
      const child = new MockPtyChild();
      const clock = createFakeClock();
      let spawnInput: PtyAdapter.PtySpawnInput | undefined;
      const ptyAdapter: PtyAdapter.PtyAdapter["Service"] = {
        spawn: (input) => {
          spawnInput = input;
          return Effect.succeed(child);
        },
      };
      const resultFiber = yield* Effect.forkChild(
        probeGrokUsageLimits(
          { binaryPath: "grok", cwd: "/tmp", checkedAt: "2026-07-07T12:00:00.000Z" },
          ptyAdapter,
          clock,
        ),
        { startImmediately: true },
      );

      expect(spawnInput?.args).toEqual([]);
      expect(child.writes).toEqual(["/usage\r"]);
      child.emitData("Weekly limit: 32%\n");
      expect(child.killed).toBe(false);
      child.emitData("Next reset: July 11, 02:10 PT\n");

      const result = yield* Fiber.join(resultFiber);
      expect(result.usageLimits.windows[0]?.resetsAt).toBe("2026-07-11T09:10:00.000Z");
      expect(child.killed).toBe(true);
    }),
  );
});
