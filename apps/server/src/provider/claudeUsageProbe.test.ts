import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import * as PtyAdapter from "../terminal/PtyAdapter.ts";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  CLAUDE_USAGE_PROBE_TIMEOUT_MS,
  parseClaudeUsageLimitsOutput,
  probeClaudeUsageLimits,
  type ProbeClock,
} from "./claudeUsageProbe.ts";

/**
 * Binary resolution is platform-dependent, so pin the platform rather than
 * letting assertions depend on whichever OS the suite happens to run on.
 */
const probeClaudeUsageLimitsOnLinux = (
  input: Parameters<typeof probeClaudeUsageLimits>[0],
  ptyAdapter: PtyAdapter.PtyAdapter["Service"],
  clock?: ProbeClock,
) =>
  probeClaudeUsageLimits(input, clock).pipe(
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provideService(PtyAdapter.PtyAdapter, ptyAdapter),
  );

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
      reason: "Could not read usage limits for this Claude account.",
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

  // Captured verbatim from `claude --print /usage --output-format json` on a
  // Pro subscription: a session line with no accompanying weekly line, plus the
  // trailing "contributing to your limits" breakdown the CLI now appends.
  it("parses real print-mode output that reports only a session window", () => {
    const output = JSON.stringify({
      type: "result",
      subtype: "success",
      result: [
        "You are currently using your subscription to power your Claude Code usage",
        "",
        "Current session: 54% used · resets Jul 25, 10:09pm (Asia/Calcutta)",
        "",
        "What's contributing to your limits usage?",
        "Last 24h · 341 requests · 3 sessions",
        "  76% of your usage was at >150k context",
      ].join("\n"),
    });

    expect(
      parseClaudeUsageLimitsOutput({
        checkedAt: "2026-07-25T12:00:00.000Z",
        output,
      }),
    ).toMatchObject({
      available: true,
      windows: [
        {
          kind: "session",
          usedPercent: 54,
          windowDurationMins: 300,
          resetsAt: "2026-07-25T16:39:00.000Z",
        },
      ],
    });
  });

  // Captured from Claude Code 2.1.233. The contributing-stats block includes
  // "Last 7d" and a 73% context line — those are not the weekly quota.
  it("does not treat contributing Last 7d stats as a weekly quota window", () => {
    const output = JSON.stringify({
      type: "result",
      subtype: "success",
      result: [
        "You are currently using your subscription to power your Claude Code usage",
        "",
        "Current session: 10% used · resets Aug 16, 5:40pm (Asia/Kolkata)",
        "",
        "What's contributing to your limits usage?",
        "Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.",
        "",
        "Last 24h · 454 requests · 3 sessions",
        "  77% of your usage was at >150k context",
        "",
        "Last 7d · 1505 requests · 35 sessions",
        "  73% of your usage was at >150k context",
      ].join("\n"),
    });

    const parsed = parseClaudeUsageLimitsOutput({
      checkedAt: "2026-08-16T08:30:00.000Z",
      output,
    });

    expect(parsed.available).toBe(true);
    expect(parsed.windows).toEqual([
      {
        kind: "session",
        label: "Session",
        usedPercent: 10,
        windowDurationMins: 300,
        resetsAt: "2026-08-16T12:10:00.000Z",
      },
    ]);
  });

  it("parses a yearless reset without a timezone as a host-local wall clock", () => {
    const parsed = parseClaudeUsageLimitsOutput({
      checkedAt: "2026-08-16T08:30:00.000Z",
      output: "Current session: 10% used · resets Aug 16, 5:40pm",
    });
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const expected = DateTime.makeZoned("2026-08-16 17:40:00", {
      timeZone,
      adjustForTimeZone: true,
    });

    expect(parsed.windows).toHaveLength(1);
    expect(parsed.windows[0]?.usedPercent).toBe(10);
    expect(Option.isSome(expected)).toBe(true);
    if (Option.isSome(expected)) {
      expect(parsed.windows[0]?.resetsAt).toBe(DateTime.formatIso(expected.value));
    }
  });

  it("parses Claude print-mode JSON with current session and week labels", () => {
    const output = JSON.stringify({
      type: "result",
      subtype: "success",
      result: [
        "You are currently using your subscription to power your Claude Code usage",
        "",
        "Current session: 0% used · resets Jul 18, 3:39pm (Asia/Kolkata)",
        "Current week (Fable): 18% used · resets Jul 24, 2:29pm (Asia/Kolkata)",
      ].join("\n"),
    });

    expect(
      parseClaudeUsageLimitsOutput({
        checkedAt: "2026-07-18T10:00:00.000Z",
        output,
      }),
    ).toMatchObject({
      available: true,
      windows: [
        {
          kind: "session",
          usedPercent: 0,
          windowDurationMins: 300,
          resetsAt: "2026-07-18T10:09:00.000Z",
        },
        {
          kind: "weekly",
          usedPercent: 18,
          windowDurationMins: 10080,
          resetsAt: "2026-07-24T08:59:00.000Z",
        },
      ],
    });
  });

  it("parses punctuated IANA time zone identifiers", () => {
    const parsed = parseClaudeUsageLimitsOutput({
      checkedAt: "2026-07-18T10:00:00.000Z",
      output: JSON.stringify({
        result: "Current session: 25% used · resets Jul 18, 9:00am (Etc/GMT+5)",
      }),
    });

    expect(parsed.windows[0]?.resetsAt).toBe("2026-07-18T14:00:00.000Z");
  });

  it("keeps usage available when an IANA time zone is invalid", () => {
    const parsed = parseClaudeUsageLimitsOutput({
      checkedAt: "2026-07-18T10:00:00.000Z",
      output: JSON.stringify({
        result: "Current session: 25% used · resets Jul 18, 9:00am (Not/AZone)",
      }),
    });

    expect(parsed.available).toBe(true);
    expect(parsed.windows[0]).toMatchObject({ usedPercent: 25 });
    expect(parsed.windows[0]?.resetsAt).toBeUndefined();
  });

  it("rolls the reset year forward when a year-less IANA-zone reset wraps into next year", () => {
    const output = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Current session: 50% used · resets Jan 3, 9:00am (Asia/Kolkata)",
    });

    const parsed = parseClaudeUsageLimitsOutput({
      checkedAt: "2026-12-30T10:00:00.000Z",
      output,
    });

    expect(parsed.windows[0]?.resetsAt).toBe("2027-01-03T03:30:00.000Z");
  });

  it("does not roll stale same-year or explicitly dated resets forward", () => {
    const staleYearless = parseClaudeUsageLimitsOutput({
      checkedAt: "2026-07-20T10:00:00.000Z",
      output: JSON.stringify({
        result: "Current session: 50% used · resets Jul 10, 9:00am (Asia/Kolkata)",
      }),
    });
    const explicitYear = parseClaudeUsageLimitsOutput({
      checkedAt: "2026-12-30T10:00:00.000Z",
      output: JSON.stringify({
        result: "Current session: 50% used · resets Jan 3, 2026, 9:00am (Asia/Kolkata)",
      }),
    });

    expect(staleYearless.windows[0]?.resetsAt).toBe("2026-07-10T03:30:00.000Z");
    expect(explicitYear.windows[0]?.resetsAt).toBe("2026-01-03T03:30:00.000Z");
  });

  it.effect("collects Claude print-mode JSON until the process exits", () =>
    Effect.gen(function* () {
      const child = new MockPtyChild();
      const resultFiber = yield* Effect.forkChild(
        probeClaudeUsageLimitsOnLinux(
          {
            binaryPath: "claude",
            cwd: "/tmp",
            checkedAt: "2026-07-18T10:00:00.000Z",
          },
          makeMockPtyAdapter(child),
          createFakeClock(),
        ),
        { startImmediately: true },
      );

      child.emitData('{"result":"Current session: 12% used\\nCurrent week (Fable): 34% used"}');
      child.emitExit();

      const result = yield* Fiber.join(resultFiber);
      expect(result.usageLimits.windows.map((window) => window.usedPercent)).toEqual([12, 34]);
      expect(child.writes).toEqual([]);
      // The PTY exited on its own, so cleanup must not kill it again. On
      // Windows, killing an already-dead conpty crashes node-pty's teardown
      // and takes the server process down with it.
      expect(child.kill).not.toHaveBeenCalled();
    }),
  );

  it.effect("resolves unavailable on timeout with no output", () =>
    Effect.gen(function* () {
      const child = new MockPtyChild();
      const clock = createFakeClock();
      const resultFiber = yield* Effect.forkChild(
        probeClaudeUsageLimitsOnLinux(
          {
            binaryPath: "claude",
            cwd: "/tmp",
            checkedAt: "2026-07-18T10:00:00.000Z",
          },
          makeMockPtyAdapter(child),
          clock,
        ),
        { startImmediately: true },
      );

      clock.advance(CLAUDE_USAGE_PROBE_TIMEOUT_MS);
      const result = yield* Fiber.join(resultFiber);

      expect(result.usageLimits.available).toBe(false);
      expect(result.rawOutput).toBe("");
      // Timing out leaves the PTY alive, so cleanup must still kill it.
      expect(child.kill).toHaveBeenCalled();
    }),
  );

  it.effect("returns unavailable result when spawn fails", () =>
    Effect.gen(function* () {
      const failingAdapter: PtyAdapter.PtyAdapter["Service"] = {
        spawn: () =>
          Effect.fail(
            new PtyAdapter.PtySpawnError({
              adapter: "mock",
              cause: new Error("spawn failed"),
            }),
          ),
      };

      const result = yield* probeClaudeUsageLimitsOnLinux(
        {
          binaryPath: "claude",
          cwd: "/tmp",
          checkedAt: "2026-04-17T10:00:00.000Z",
        },
        failingAdapter,
      );

      expect(result.usageLimits.available).toBe(false);
      expect(result.usageLimits.reason).toBe("Failed to spawn Claude process for usage probe.");
      expect(result.rawOutput).toBe("");
    }),
  );

  it.effect("preserves quoted launch arguments when spawning the probe process", () =>
    Effect.gen(function* () {
      const child = new MockPtyChild();
      let capturedSpawnInput: PtyAdapter.PtySpawnInput | undefined;
      const ptyAdapter = makeCapturingPtyAdapter({
        child,
        onSpawn: (spawnInput) => {
          capturedSpawnInput = spawnInput;
        },
      });

      const resultFiber = yield* Effect.forkChild(
        probeClaudeUsageLimitsOnLinux(
          {
            binaryPath: "claude",
            launchArgs: '--model "claude sonnet" --cwd "/tmp/with spaces" --note "say \\"hi\\""',
            cwd: "/tmp",
            checkedAt: "2026-04-17T10:00:00.000Z",
          },
          ptyAdapter,
        ),
        { startImmediately: true },
      );

      child.emitExit();
      yield* Fiber.join(resultFiber);

      expect(capturedSpawnInput?.args).toEqual([
        "--model",
        "claude sonnet",
        "--cwd",
        "/tmp/with spaces",
        "--note",
        'say "hi"',
        "--print",
        "/usage",
        "--output-format",
        "json",
        "--permission-mode",
        "plan",
      ]);
    }),
  );

  it.effect("preserves Windows paths in quoted launch arguments", () =>
    Effect.gen(function* () {
      const child = new MockPtyChild();
      let capturedSpawnInput: PtyAdapter.PtySpawnInput | undefined;
      const ptyAdapter = makeCapturingPtyAdapter({
        child,
        onSpawn: (spawnInput) => {
          capturedSpawnInput = spawnInput;
        },
      });

      const resultFiber = yield* Effect.forkChild(
        probeClaudeUsageLimitsOnLinux(
          {
            binaryPath: "claude",
            launchArgs: String.raw`--add-dir "C:\work\repo"`,
            cwd: "/tmp",
            checkedAt: "2026-04-17T10:00:00.000Z",
          },
          ptyAdapter,
        ),
        { startImmediately: true },
      );

      child.emitExit();
      yield* Fiber.join(resultFiber);

      expect(capturedSpawnInput?.args?.slice(0, 2)).toEqual([
        "--add-dir",
        String.raw`C:\work\repo`,
      ]);
    }),
  );

  it.effect("reports usage unavailable when no PTY adapter is in the environment", () =>
    Effect.gen(function* () {
      const result = yield* probeClaudeUsageLimits({
        binaryPath: "claude",
        cwd: "/tmp",
        checkedAt: "2026-04-17T10:00:00.000Z",
      }).pipe(Effect.provideService(HostProcessPlatform, "linux"));

      expect(result.usageLimits).toEqual({
        source: "claudeStatusProbe",
        available: false,
        reason: "Usage limits are unavailable in this runtime.",
        checkedAt: "2026-04-17T10:00:00.000Z",
        windows: [],
      });
    }),
  );
});
