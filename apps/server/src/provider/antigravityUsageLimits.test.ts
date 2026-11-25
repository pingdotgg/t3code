import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import {
  AntigravityCliUsageError,
  antigravitySummaryWindows,
  makeAntigravityUsageProbe,
  parseAntigravityCliUsageOutput,
  type AntigravityCliUsageRunInput,
} from "./antigravityUsageLimits.ts";

const SAMPLE_CLI_OUTPUT = [
  "\x1b[2J\x1b[1;1HModels & Quota  Account: user@example.com",
  "",
  "GEMINI MODELS",
  "  Models within this group: Gemini 4 Neon, Gemini 4 Carbon",
  "",
  "  Weekly Limit Remaining",
  "    [████████████████████████████████████░░] 91.26%",
  "    Refreshes in 156h 19m",
  "",
  "  Five Hour Limit Remaining",
  "    [██████████████████████████████████████░] 95.89%",
  "    Refreshes in 4h 17m",
  "",
  "CLAUDE AND GPT MODELS",
  "  Models within this group: Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B",
  "",
  "  Weekly Limit Remaining",
  "    [████████████████████████████████████████] 100.00%",
  "    Refreshes in 117h 54m",
  "",
  "  Five Hour Limit Remaining",
  "    [████████████████████████████████████████] 100.00%",
  "    Quota available",
].join("\n");

const isoAt = (epochMs: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMs));

describe("parseAntigravityCliUsageOutput", () => {
  it("parses Gemini and 3P groups, ordering 5-hour before Weekly and computing reset timestamps", () => {
    const nowMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T17:00:00.000Z"));
    const parsed = parseAntigravityCliUsageOutput(SAMPLE_CLI_OUTPUT, nowMs);
    expect(parsed).toBeDefined();
    expect(parsed?.accountEmail).toBe("user@example.com");
    expect(parsed?.windows).toEqual([
      {
        id: "gemini-5h",
        label: "Gemini · 5-hour",
        kind: "session",
        usedPercent: 4.11,
        windowDurationMins: 300,
        resetsAt: isoAt(nowMs + (4 * 60 + 17) * 60_000),
      },
      {
        id: "gemini-weekly",
        label: "Gemini · Weekly",
        kind: "weekly",
        usedPercent: 8.74,
        windowDurationMins: 10080,
        resetsAt: isoAt(nowMs + (156 * 60 + 19) * 60_000),
      },
      {
        id: "3p-5h",
        label: "Claude & GPT (shared) · 5-hour",
        kind: "session",
        usedPercent: 0,
        windowDurationMins: 300,
      },
      {
        id: "3p-weekly",
        label: "Claude & GPT (shared) · Weekly",
        kind: "weekly",
        usedPercent: 0,
        windowDurationMins: 10080,
        resetsAt: isoAt(nowMs + (117 * 60 + 54) * 60_000),
      },
    ]);
  });

  it("uses the latest Models & Quota frame when BubbleTea redraws", () => {
    const nowMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T17:00:00.000Z"));
    const redrawn =
      "Models & Quota\nLoading quota summary...\n" +
      "\x1b[1;1HModels & Quota  Account: user@example.com\x1b[3;1HGEMINI MODELS\x1b[5;1HFive Hour Limit Remaining\x1b[6;1H[████] 50.00%\x1b[7;1HRefreshes in 1d 2h";
    const parsed = parseAntigravityCliUsageOutput(redrawn, nowMs);
    expect(parsed?.windows).toEqual([
      {
        id: "gemini-5h",
        label: "Gemini · 5-hour",
        kind: "session",
        usedPercent: 50,
        windowDurationMins: 300,
        resetsAt: isoAt(nowMs + 26 * 3_600_000),
      },
    ]);
  });

  it("returns undefined when output has no quota groups", () => {
    const nowMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T17:00:00.000Z"));
    expect(parseAntigravityCliUsageOutput("Antigravity CLI 1.5.16", nowMs)).toBeUndefined();
  });
});

describe("makeAntigravityUsageProbe (official CLI)", () => {
  it.effect("reads quota via official CLI, caches for 5m, and enforces 60s floor on clear()", () =>
    Effect.gen(function* () {
      const startMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T17:00:00Z"));
      yield* TestClock.setTime(startMs);
      const fs = yield* FileSystem.FileSystem;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      const invocations: AntigravityCliUsageRunInput[] = [];

      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "oauth-personal",
        resolveExecutable: Effect.succeed("/usr/local/bin/agy"),
        environment: { PATH: "/usr/local/bin", ELECTRON_RUN_AS_NODE: "1" },
        runCliUsage: (args) => {
          invocations.push(args);
          return Effect.succeed(SAMPLE_CLI_OUTPUT);
        },
      });

      const first = yield* usage.probe;
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.executablePath).toBe("/usr/local/bin/agy");
      expect(invocations[0]?.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(invocations[0]?.env.GEMINI_HOME).toBeUndefined();
      expect(first.unavailable).toBeUndefined();
      expect(first.windows).toHaveLength(4);
      expect(first.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);

      // Within 5 minutes: served from cache without spawning CLI again.
      yield* TestClock.adjust("2 minutes");
      yield* usage.probe;
      expect(invocations).toHaveLength(1);

      // Manual clear() still respects 60s safety floor when probed immediately.
      yield* usage.clear;
      yield* TestClock.adjust("1 minute");
      yield* usage.probe;
      expect(invocations).toHaveLength(2);

      // Immediate second clear() within 60s stays cached.
      yield* usage.clear;
      yield* TestClock.adjust("20 seconds");
      yield* usage.probe;
      expect(invocations).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("scopes GEMINI_HOME when a profile-specific CLI token file exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(profileDirectory, "antigravity-acp"));
      yield* fs.writeFileString(
        path.join(profileDirectory, "antigravity-acp", "antigravity-oauth-token"),
        "{}",
      );
      const invocations: AntigravityCliUsageRunInput[] = [];

      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "oauth-personal",
        runCliUsage: (args) => {
          invocations.push(args);
          return Effect.succeed(SAMPLE_CLI_OUTPUT);
        },
      });

      yield* usage.probe;
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.env.GEMINI_HOME).toBe(profileDirectory);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("returns unsupported for API key auth without invoking the CLI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      let calls = 0;

      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "gemini-api-key",
        runCliUsage: () => {
          calls++;
          return Effect.succeed(SAMPLE_CLI_OUTPUT);
        },
      });

      const limits = yield* usage.probe;
      expect(calls).toBe(0);
      expect(limits.unavailable?.reason).toBe("unsupported");
      expect(limits.windows).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("returns probeFailed when CLI invocation fails without prior cache", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();

      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "oauth-personal",
        runCliUsage: () => Effect.fail(new AntigravityCliUsageError({ detail: "CLI unavailable" })),
      });

      const limits = yield* usage.probe;
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(limits.windows).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

describe("antigravitySummaryWindows (CLIProxyAPI hub helper)", () => {
  it.effect("omits rolling resets for untouched summary buckets and keeps used Gemini resets", () =>
    Effect.gen(function* () {
      const requestedAt = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z"));
      const windows = yield* antigravitySummaryWindows(
        {
          groups: [
            {
              buckets: [
                {
                  bucketId: "3p-5h",
                  window: "5h",
                  remainingFraction: 1,
                  resetTime: "2026-10-21T15:16:05Z",
                },
                {
                  bucketId: "gemini-5h",
                  window: "5h",
                  remainingFraction: 0.85,
                  resetTime: "2026-10-21T13:29:53Z",
                  description: "Used some of your 5-hour limit.",
                },
              ],
            },
          ],
        },
        requestedAt,
      );
      const byId = new Map(windows.map((window) => [window.id, window]));
      expect(byId.get("3p-5h")).toEqual({
        id: "3p-5h",
        label: "Claude & GPT (shared) · 5-hour",
        kind: "session",
        usedPercent: 0,
        windowDurationMins: 300,
      });
      expect(byId.get("gemini-5h")?.resetsAt).toBe("2026-10-21T13:29:53.000Z");
    }),
  );
});
