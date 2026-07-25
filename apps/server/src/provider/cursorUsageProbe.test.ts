import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as PtyAdapter from "../terminal/PtyAdapter.ts";

import {
  parseCursorUsageLimitsOutput,
  probeCursorUsageLimits,
  type ProbeClock,
} from "./cursorUsageProbe.ts";

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

const SAMPLE_OUTPUT = `
 Usage • Free                                                                         Resets 7 Aug
 Monthly plan and on-demand usage

 Category        Current             Usage
 Included        23% used            ░░░░░░░░░░
   Auto          10% used            ░░░░░░░░░░
   API           13% used            ░░░░░░░░░░
 On-Demand       Disabled            ----------

 On-demand usage is off

 View in dashboard: cursor.com/dashboard?tab=usage

 Esc to close
`;

describe("cursorUsageProbe", () => {
  it("parses the included percent and reset date from Cursor's /usage panel", () => {
    const parsed = parseCursorUsageLimitsOutput({
      checkedAt: "2026-07-25T12:00:00.000Z",
      output: SAMPLE_OUTPUT,
    });

    expect(parsed.available).toBe(true);
    expect(parsed.source).toBe("cursorStatusProbe");
    expect(parsed.windows).toHaveLength(1);
    expect(parsed.windows[0]).toMatchObject({
      label: "Included",
      usedPercent: 23,
      windowDurationMins: 30 * 24 * 60,
    });
    expect(parsed.windows[0]?.resetsAt).toBe("2026-08-07T00:00:00.000Z");
  });

  it("does not mistake the indented Auto/API sub-rows for the Included row", () => {
    const parsed = parseCursorUsageLimitsOutput({
      checkedAt: "2026-07-25T12:00:00.000Z",
      output: SAMPLE_OUTPUT,
    });

    expect(parsed.windows[0]?.usedPercent).not.toBe(10);
    expect(parsed.windows[0]?.usedPercent).not.toBe(13);
  });

  it("returns unavailable when the Included row is absent", () => {
    expect(
      parseCursorUsageLimitsOutput({
        checkedAt: "2026-07-25T12:00:00.000Z",
        output: "Esc to close",
      }),
    ).toEqual({
      source: "cursorStatusProbe",
      available: false,
      checkedAt: "2026-07-25T12:00:00.000Z",
      reason: "Could not read usage limits for this Cursor account.",
      windows: [],
    });
  });

  it("rolls the reset year forward when a year-less reset wraps into next year", () => {
    const parsed = parseCursorUsageLimitsOutput({
      checkedAt: "2026-12-30T12:00:00.000Z",
      output: "Usage • Free   Resets 3 Jan\nIncluded  90% used  ░░░",
    });

    expect(parsed.windows[0]?.resetsAt).toBe("2027-01-03T00:00:00.000Z");
  });

  it("does not roll a stale same-year reset forward", () => {
    const parsed = parseCursorUsageLimitsOutput({
      checkedAt: "2026-07-20T12:00:00.000Z",
      output: "Usage • Free   Resets 10 Jul\nIncluded  90% used  ░░░",
    });

    expect(parsed.windows[0]?.resetsAt).toBe("2026-07-10T00:00:00.000Z");
  });

  it.effect("writes /usage and settles after output stabilizes using the default probe clock", () =>
    Effect.gen(function* () {
      const child = new MockPtyChild();
      child.onWrite = () => {
        child.emitData(SAMPLE_OUTPUT);
      };
      const ptyAdapter: PtyAdapter.PtyAdapter["Service"] = {
        spawn: () => Effect.succeed(child),
      };

      const result = yield* probeCursorUsageLimits(
        { binaryPath: "cursor-agent", cwd: "/tmp", checkedAt: "2026-07-25T12:00:00.000Z" },
        ptyAdapter,
      );

      expect(result.usageLimits.windows[0]?.usedPercent).toBe(23);
      expect(child.writes).toEqual(["/usage\r"]);
      expect(child.killed).toBe(true);
    }),
  );

  it.effect("passes -e <apiEndpoint> when a custom API endpoint is configured", () =>
    Effect.gen(function* () {
      const child = new MockPtyChild();
      let spawnInput: PtyAdapter.PtySpawnInput | undefined;
      const ptyAdapter: PtyAdapter.PtyAdapter["Service"] = {
        spawn: (input) => {
          spawnInput = input;
          return Effect.succeed(child);
        },
      };

      yield* Effect.forkChild(
        probeCursorUsageLimits(
          {
            binaryPath: "cursor-agent",
            apiEndpoint: "https://example.com",
            cwd: "/tmp",
            checkedAt: "2026-07-25T12:00:00.000Z",
          },
          ptyAdapter,
        ),
        { startImmediately: true },
      );

      expect(spawnInput?.args).toEqual(["-e", "https://example.com"]);
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
        probeCursorUsageLimits(
          { binaryPath: "cursor-agent", cwd: "/tmp", checkedAt: "2026-07-25T12:00:00.000Z" },
          ptyAdapter,
          clock,
        ),
        { startImmediately: true },
      );

      child.emitData("Included  23% used  ░░░\n");
      clock.advance(199);
      expect(child.killed).toBe(false);
      clock.advance(1);

      const result = yield* Fiber.join(resultFiber);
      expect(result.usageLimits).toMatchObject({ available: true });
      expect(result.usageLimits.windows[0]?.resetsAt).toBeUndefined();
      expect(child.killed).toBe(true);
    }),
  );
});
