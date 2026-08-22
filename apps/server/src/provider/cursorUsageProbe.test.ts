import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as PtyAdapter from "../terminal/PtyAdapter.ts";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  parseCursorUsageLimitsOutput,
  probeCursorUsageLimits,
  type ProbeClock,
} from "./cursorUsageProbe.ts";

/**
 * Binary resolution is platform-dependent, so pin the platform rather than
 * letting assertions depend on whichever OS the suite happens to run on.
 */
const probeCursorUsageLimitsOnLinux = (
  input: Parameters<typeof probeCursorUsageLimits>[0],
  ptyAdapter: PtyAdapter.PtyAdapter["Service"],
  clock?: ProbeClock,
) =>
  probeCursorUsageLimits(input, clock).pipe(
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provideService(PtyAdapter.PtyAdapter, ptyAdapter),
  );

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
      const due = timers.filter((entry) => !entry.cancelled);
      for (const timer of due) {
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

const COMPOSER_READY = `
  Cursor Agent
  v2026.08.11-e8db854
  Tip: Use /debug to instrument and debug complex problems.
  → Plan, search, build anything
`;

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
  it("parses Auto and API percents plus the reset date", () => {
    const parsed = parseCursorUsageLimitsOutput({
      checkedAt: "2026-07-25T12:00:00.000Z",
      output: SAMPLE_OUTPUT,
    });

    expect(parsed.available).toBe(true);
    expect(parsed.source).toBe("cursorStatusProbe");
    expect(parsed.windows).toEqual([
      {
        kind: "weekly",
        label: "Auto",
        usedPercent: 10,
        windowDurationMins: 30 * 24 * 60,
        resetsAt: "2026-08-07T00:00:00.000Z",
      },
      {
        kind: "weekly",
        label: "API",
        usedPercent: 13,
        windowDurationMins: 30 * 24 * 60,
        resetsAt: "2026-08-07T00:00:00.000Z",
      },
    ]);
  });

  it("parses Cursor Pro /usage with a Sept reset and a zero API bar", () => {
    const parsed = parseCursorUsageLimitsOutput({
      checkedAt: "2026-08-16T12:00:00.000Z",
      output: `
 Usage • Pro                                                                                                                               Resets 16 Sept
 Monthly plan and on-demand usage

 Category        Current             Usage
 Included        2% used             ██░░░░░░░░
   Auto          2% used             ███░░░░░░░
   API           0% used             ░░░░░░░░░░
`,
    });

    expect(parsed.windows).toEqual([
      {
        kind: "weekly",
        label: "Auto",
        usedPercent: 2,
        windowDurationMins: 30 * 24 * 60,
        resetsAt: "2026-09-16T00:00:00.000Z",
      },
      {
        kind: "weekly",
        label: "API",
        usedPercent: 0,
        windowDurationMins: 30 * 24 * 60,
        resetsAt: "2026-09-16T00:00:00.000Z",
      },
    ]);
  });

  it("parses OSC-8 hyperlink frames without dropping Auto, API, or the reset", () => {
    const osc = String.fromCharCode(27);
    const parsed = parseCursorUsageLimitsOutput({
      checkedAt: "2026-08-16T12:00:00.000Z",
      output: [
        `${osc}]8;id=1;https://github.com/example/pull/1${osc}\\#1${osc}]8;;${osc}\\`,
        `${osc}[36mLoading usage data...${osc}[m`,
        `${osc}[1mUsage${osc}[m • Pro${osc}[91CResets 16 Sept`,
        " Included        6% used",
        `${osc}[2m  Auto${osc}[22m${osc}[10C7% used`,
        `${osc}[2m  API${osc}[22m${osc}[11C0% used`,
        `${osc}]8;id=2;https://cursor.com/dashboard?tab=usage${osc}\\cursor.com${osc}]8;;${osc}\\`,
        "Esc to close",
      ].join("\n"),
    });

    expect(
      parsed.windows.map((window) => [window.label, window.usedPercent, window.resetsAt]),
    ).toEqual([
      ["Auto", 7, "2026-09-16T00:00:00.000Z"],
      ["API", 0, "2026-09-16T00:00:00.000Z"],
    ]);
  });

  it("reads a reset glued to the plan name after Ink cursor addressing", () => {
    const parsed = parseCursorUsageLimitsOutput({
      checkedAt: "2026-08-16T12:00:00.000Z",
      output: "Usage • ProResets 16 Sept\nAuto  8% used\nAPI  0% used",
    });

    expect(parsed.windows[0]?.resetsAt).toBe("2026-09-16T00:00:00.000Z");
    expect(parsed.windows.map((window) => window.label)).toEqual(["Auto", "API"]);
  });

  it("parses the compact colon layout Ink uses on a narrow PTY", () => {
    const parsed = parseCursorUsageLimitsOutput({
      checkedAt: "2026-08-16T12:00:00.000Z",
      output:
        "Usage • Pro  Resets Sep 16\nIncluded: 2% used\nAuto: 2% used\nAPI: 0% used\nOn-Demand: Disabled",
    });

    expect(parsed.windows.map((window) => [window.label, window.usedPercent])).toEqual([
      ["Auto", 2],
      ["API", 0],
    ]);
    expect(parsed.windows[0]?.resetsAt).toBe("2026-09-16T00:00:00.000Z");
  });

  it("ignores the Included total when Auto and API are missing", () => {
    const parsed = parseCursorUsageLimitsOutput({
      checkedAt: "2026-07-25T12:00:00.000Z",
      output: "Usage • Free   Resets 7 Aug\nIncluded  23% used  ░░░",
    });

    expect(parsed.available).toBe(false);
    expect(parsed.windows).toEqual([]);
  });

  it("returns unavailable when no percent rows are present", () => {
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
      output: "Usage • Free   Resets 3 Jan\nAuto  90% used  ░░░",
    });

    expect(parsed.windows[0]?.resetsAt).toBe("2027-01-03T00:00:00.000Z");
  });

  it("does not roll a stale same-year reset forward", () => {
    const parsed = parseCursorUsageLimitsOutput({
      checkedAt: "2026-07-20T12:00:00.000Z",
      output: "Usage • Free   Resets 10 Jul\nAuto  90% used  ░░░",
    });

    expect(parsed.windows[0]?.resetsAt).toBe("2026-07-10T00:00:00.000Z");
  });

  it.effect("writes /usage after the composer is ready, not during the splash", () =>
    Effect.gen(function* () {
      const child = new MockPtyChild();
      const clock = createFakeClock();
      child.onWrite = (data) => {
        if (data === "/usage\r") {
          child.emitData(SAMPLE_OUTPUT);
        }
      };
      const ptyAdapter: PtyAdapter.PtyAdapter["Service"] = {
        spawn: () => Effect.succeed(child),
      };
      const resultFiber = yield* Effect.forkChild(
        probeCursorUsageLimitsOnLinux(
          { binaryPath: "cursor-agent", cwd: "/tmp", checkedAt: "2026-07-25T12:00:00.000Z" },
          ptyAdapter,
          clock,
        ),
        { startImmediately: true },
      );

      expect(child.writes).toEqual([]);
      child.emitData(COMPOSER_READY);
      expect(child.writes).toEqual([]);
      clock.advance(799);
      expect(child.writes).toEqual([]);
      clock.advance(1);

      const result = yield* Fiber.join(resultFiber);
      expect(
        result.usageLimits.windows.map((window) => [window.label, window.usedPercent]),
      ).toEqual([
        ["Auto", 10],
        ["API", 13],
      ]);
      expect(child.writes).toEqual(["/usage\r"]);
      expect(child.killed).toBe(true);
    }),
  );

  it.effect("accepts /usage from the slash palette instead of leaving it highlighted", () =>
    Effect.gen(function* () {
      const child = new MockPtyChild();
      const clock = createFakeClock();
      child.onWrite = (data) => {
        if (data === "/usage\r") {
          child.emitData("→ /usage  Show plan and on-demand usage\n");
        }
        if (data === "\r") {
          child.emitData(SAMPLE_OUTPUT);
        }
      };
      const ptyAdapter: PtyAdapter.PtyAdapter["Service"] = {
        spawn: () => Effect.succeed(child),
      };
      const resultFiber = yield* Effect.forkChild(
        probeCursorUsageLimitsOnLinux(
          { binaryPath: "cursor-agent", cwd: "/tmp", checkedAt: "2026-07-25T12:00:00.000Z" },
          ptyAdapter,
          clock,
        ),
        { startImmediately: true },
      );

      child.emitData(COMPOSER_READY);
      clock.advance(800);

      const result = yield* Fiber.join(resultFiber);
      expect(child.writes).toEqual(["/usage\r", "\r"]);
      expect(
        result.usageLimits.windows.map((window) => [window.label, window.usedPercent]),
      ).toEqual([
        ["Auto", 10],
        ["API", 13],
      ]);
      expect(result.usageLimits.windows[0]?.resetsAt).toBe("2026-08-07T00:00:00.000Z");
    }),
  );

  it.effect("treats the wide-PTY Run a command placeholder as composer-ready", () =>
    Effect.gen(function* () {
      const child = new MockPtyChild();
      const clock = createFakeClock();
      child.onWrite = (data) => {
        if (data === "/usage\r") {
          child.emitData(SAMPLE_OUTPUT);
        }
      };
      const ptyAdapter: PtyAdapter.PtyAdapter["Service"] = {
        spawn: () => Effect.succeed(child),
      };
      const resultFiber = yield* Effect.forkChild(
        probeCursorUsageLimitsOnLinux(
          { binaryPath: "cursor-agent", cwd: "/tmp", checkedAt: "2026-07-25T12:00:00.000Z" },
          ptyAdapter,
          clock,
        ),
        { startImmediately: true },
      );

      child.emitData("Cursor Agent\n→ Run a command — e.g., dir\n");
      expect(child.writes).toEqual([]);
      clock.advance(800);

      const result = yield* Fiber.join(resultFiber);
      expect(result.usageLimits.available).toBe(true);
      expect(child.writes).toEqual(["/usage\r"]);
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
        probeCursorUsageLimitsOnLinux(
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

      expect(spawnInput?.args).toEqual(["--trust", "-e", "https://example.com"]);
    }),
  );

  it.effect("settles Auto and API even when no reset line arrives", () =>
    Effect.gen(function* () {
      const child = new MockPtyChild();
      const clock = createFakeClock();
      const ptyAdapter: PtyAdapter.PtyAdapter["Service"] = {
        spawn: () => Effect.succeed(child),
      };
      const resultFiber = yield* Effect.forkChild(
        probeCursorUsageLimitsOnLinux(
          { binaryPath: "cursor-agent", cwd: "/tmp", checkedAt: "2026-07-25T12:00:00.000Z" },
          ptyAdapter,
          clock,
        ),
        { startImmediately: true },
      );

      child.emitData("Auto  10% used\nAPI  13% used\n");

      const result = yield* Fiber.join(resultFiber);
      expect(result.usageLimits).toMatchObject({ available: true });
      expect(result.usageLimits.windows.map((window) => window.label)).toEqual(["Auto", "API"]);
      expect(result.usageLimits.windows[0]?.resetsAt).toBeUndefined();
      expect(child.killed).toBe(true);
    }),
  );

  it.effect("does not finish on Included+Resets until Auto and API arrive", () =>
    Effect.gen(function* () {
      const child = new MockPtyChild();
      const clock = createFakeClock();
      const ptyAdapter: PtyAdapter.PtyAdapter["Service"] = {
        spawn: () => Effect.succeed(child),
      };
      const resultFiber = yield* Effect.forkChild(
        probeCursorUsageLimitsOnLinux(
          { binaryPath: "cursor-agent", cwd: "/tmp", checkedAt: "2026-08-16T12:00:00.000Z" },
          ptyAdapter,
          clock,
        ),
        { startImmediately: true },
      );

      child.emitData("Usage • Pro  Resets 16 Sept\nIncluded  2% used\n");
      expect(child.killed).toBe(false);
      child.emitData("  Auto  2% used\n  API  0% used\n");

      const result = yield* Fiber.join(resultFiber);
      expect(
        result.usageLimits.windows.map((window) => [window.label, window.usedPercent]),
      ).toEqual([
        ["Auto", 2],
        ["API", 0],
      ]);
      expect(result.usageLimits.windows[0]?.resetsAt).toBe("2026-09-16T00:00:00.000Z");
      expect(child.killed).toBe(true);
    }),
  );

  it.effect("retries /usage after the slash palette misses during boot", () =>
    Effect.gen(function* () {
      const child = new MockPtyChild();
      const clock = createFakeClock();
      child.onWrite = (data) => {
        if (
          data === "/usage\r" &&
          child.writes.filter((write) => write === "/usage\r").length >= 2
        ) {
          child.emitData(SAMPLE_OUTPUT);
        }
      };
      const ptyAdapter: PtyAdapter.PtyAdapter["Service"] = {
        spawn: () => Effect.succeed(child),
      };
      const resultFiber = yield* Effect.forkChild(
        probeCursorUsageLimitsOnLinux(
          { binaryPath: "cursor-agent", cwd: "/tmp", checkedAt: "2026-07-25T12:00:00.000Z" },
          ptyAdapter,
          clock,
        ),
        { startImmediately: true },
      );

      child.emitData(COMPOSER_READY);
      expect(child.writes).toEqual([]);
      clock.advance(800);
      expect(child.writes).toEqual(["/usage\r"]);
      child.emitData("     No matches\n");
      clock.advance(1_499);
      expect(child.writes).toEqual(["/usage\r"]);
      clock.advance(1);

      const result = yield* Fiber.join(resultFiber);
      expect(child.writes).toEqual(["/usage\r", "\x1b", "/usage\r"]);
      expect(result.usageLimits.available).toBe(true);
      expect(child.killed).toBe(true);
    }),
  );

  it.effect("retries /usage on a timer even when the TUI emits nothing after the first send", () =>
    Effect.gen(function* () {
      const child = new MockPtyChild();
      const clock = createFakeClock();
      child.onWrite = (data) => {
        if (
          data === "/usage\r" &&
          child.writes.filter((write) => write === "/usage\r").length >= 2
        ) {
          child.emitData(SAMPLE_OUTPUT);
        }
      };
      const ptyAdapter: PtyAdapter.PtyAdapter["Service"] = {
        spawn: () => Effect.succeed(child),
      };
      const resultFiber = yield* Effect.forkChild(
        probeCursorUsageLimitsOnLinux(
          { binaryPath: "cursor-agent", cwd: "/tmp", checkedAt: "2026-07-25T12:00:00.000Z" },
          ptyAdapter,
          clock,
        ),
        { startImmediately: true },
      );

      child.emitData(COMPOSER_READY);
      clock.advance(800);
      expect(child.writes).toEqual(["/usage\r"]);
      clock.advance(1_500);

      const result = yield* Fiber.join(resultFiber);
      expect(child.writes).toEqual(["/usage\r", "\x1b", "/usage\r"]);
      expect(result.usageLimits.available).toBe(true);
    }),
  );
});
