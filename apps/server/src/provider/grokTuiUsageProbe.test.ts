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
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();

  public get pid(): number {
    return 12345;
  }

  public write(data: string): void {
    this.writes.push(data);
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
      reason: "Usage limits unavailable for this Grok account.",
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
