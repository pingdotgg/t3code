import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import {
  AntigravityCliUsageError,
  antigravitySummaryWindows,
  buildAntigravityCliUsageEnv,
  makeAntigravityUsageProbe,
  parseAntigravityCliUsageOutput,
  runOfficialAgyUsagePty,
  type AntigravityCliUsageRunInput,
  type AntigravityNodePtyModule,
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

const SECOND_ACCOUNT_CLI_OUTPUT = [
  "\x1b[2J\x1b[1;1HModels & Quota  Account: second@example.com",
  "",
  "GEMINI MODELS",
  "  Five Hour Limit Remaining",
  "    [████████████████████░░░░░░░░░░░░░░░░░░░░] 50.00%",
  "    Refreshes in 2h 0m",
].join("\n");

const isoAt = (epochMs: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMs));

const createProfileWithCliToken = Effect.fn("AntigravityUsageTest.createProfileWithCliToken")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const profileDirectory = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(profileDirectory, "antigravity-acp"));
    yield* fs.writeFileString(
      path.join(profileDirectory, "antigravity-acp", "antigravity-oauth-token"),
      "{}",
    );
    return profileDirectory;
  },
);

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

describe("buildAntigravityCliUsageEnv", () => {
  it("strips ambient Google credentials and launcher internals case-insensitively", () => {
    const cleaned = buildAntigravityCliUsageEnv(
      {
        PATH: "/usr/local/bin",
        GEMINI_API_KEY: "ambient-gemini-key",
        google_api_key: "ambient-google-key",
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/creds.json",
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0",
        AGY_ACP_FORCE_FILE_STORAGE: "1",
        AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1",
        ELECTRON_RUN_AS_NODE: "1",
      },
      "/profiles/a",
    );
    expect(cleaned).toEqual({
      PATH: "/usr/local/bin",
      GEMINI_HOME: "/profiles/a",
    });
  });
});

describe("runOfficialAgyUsagePty", () => {
  it.effect("waits for banner, sends /usage, captures quota output, and tears down the PTY", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      let killed = false;
      let onDataHandler: ((chunk: string) => void) | undefined;

      const fakePtyModule: AntigravityNodePtyModule = {
        spawn: () =>
          ({
            onData: (cb: (chunk: string) => void) => {
              onDataHandler = cb;
              // Emit initial CLI banner asynchronously once listener is attached.
              queueMicrotask(() => cb("Antigravity CLI 1.5.16\n"));
              return { dispose: () => {} };
            },
            onExit: () => ({ dispose: () => {} }),
            write: (data: string) => {
              writes.push(data);
              if (data === "\r") {
                queueMicrotask(() => onDataHandler?.(SAMPLE_CLI_OUTPUT));
              }
            },
            kill: () => {
              killed = true;
            },
          }) as unknown as ReturnType<AntigravityNodePtyModule["spawn"]>,
      };

      const fiber = yield* runOfficialAgyUsagePty(
        {
          executablePath: "/usr/local/bin/agy",
          env: { PATH: "/usr/local/bin" },
          cwd: "/tmp",
        },
        () => fakePtyModule,
      ).pipe(Effect.scoped, Effect.forkChild);

      yield* TestClock.adjust("5 seconds");
      const output = yield* Fiber.join(fiber);
      expect(output).toContain("Models & Quota");
      expect(writes).toEqual(["/usage", "\r", "\x1b", "\x03\x03"]);
      expect(killed).toBe(true);
    }),
  );
});

describe("makeAntigravityUsageProbe (official CLI)", () => {
  it.effect(
    "caches for 5m while preserving original checkedAt and strips ambient credentials",
    () =>
      Effect.gen(function* () {
        const startMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T17:00:00Z"));
        yield* TestClock.setTime(startMs);
        const profileDirectory = yield* createProfileWithCliToken();
        const invocations: AntigravityCliUsageRunInput[] = [];

        const usage = yield* makeAntigravityUsageProbe({
          profileDirectory,
          authMethod: "oauth-personal",
          resolveExecutable: Effect.succeed("/usr/local/bin/agy"),
          environment: {
            PATH: "/usr/local/bin",
            ELECTRON_RUN_AS_NODE: "1",
            GEMINI_API_KEY: "must-be-stripped",
          },
          runCliUsage: (args) => {
            invocations.push(args);
            return Effect.succeed(SAMPLE_CLI_OUTPUT);
          },
        });

        const first = yield* usage.probe;
        expect(invocations).toHaveLength(1);
        expect(invocations[0]?.executablePath).toBe("/usr/local/bin/agy");
        expect(invocations[0]?.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
        expect(invocations[0]?.env.GEMINI_API_KEY).toBeUndefined();
        expect(invocations[0]?.env.GEMINI_HOME).toBe(profileDirectory);
        expect(first.unavailable).toBeUndefined();
        expect(first.windows).toHaveLength(4);
        expect(first.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(first.checkedAt).toBe(isoAt(startMs));

        // Within 5 minutes: served from cache with original checkedAt preserved.
        yield* TestClock.adjust("2 minutes");
        const cached = yield* usage.probe;
        expect(invocations).toHaveLength(1);
        expect(cached.checkedAt).toBe(first.checkedAt);

        // After 5 minutes: cache expires and probes fresh data.
        yield* TestClock.adjust("4 minutes");
        const refreshed = yield* usage.probe;
        expect(invocations).toHaveLength(2);
        expect(refreshed.checkedAt).toBe(isoAt(startMs + 6 * 60_000));
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("discards cached quota immediately on clear() when switching accounts", () =>
    Effect.gen(function* () {
      const startMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T17:00:00Z"));
      yield* TestClock.setTime(startMs);
      const profileDirectory = yield* createProfileWithCliToken();
      let currentOutput = SAMPLE_CLI_OUTPUT;
      let calls = 0;

      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "oauth-personal",
        runCliUsage: () => {
          calls++;
          return Effect.succeed(currentOutput);
        },
      });

      const accountA = yield* usage.probe;
      expect(calls).toBe(1);

      // Account B signs in 20 seconds later -> clear() must drop A's snapshot immediately.
      yield* TestClock.adjust("20 seconds");
      currentOutput = SECOND_ACCOUNT_CLI_OUTPUT;
      yield* usage.clear;

      const accountB = yield* usage.probe;
      expect(calls).toBe(2);
      expect(accountB.credentialFingerprint).not.toBe(accountA.credentialFingerprint);
      expect(accountB.windows[0]?.usedPercent).toBe(50);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("applies a 60s cooldown floor after failed attempts without re-spawning the CLI", () =>
    Effect.gen(function* () {
      const startMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T17:00:00Z"));
      yield* TestClock.setTime(startMs);
      const profileDirectory = yield* createProfileWithCliToken();
      let calls = 0;

      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "oauth-personal",
        runCliUsage: () => {
          calls++;
          return Effect.fail(new AntigravityCliUsageError({ reason: "spawn_failed" }));
        },
      });

      const first = yield* usage.probe;
      expect(calls).toBe(1);
      expect(first.unavailable?.reason).toBe("probeFailed");

      // Retry 20s later stays within 60s failure cooldown.
      yield* TestClock.adjust("20 seconds");
      const second = yield* usage.probe;
      expect(calls).toBe(1);
      expect(second.unavailable?.reason).toBe("probeFailed");

      // After 60s cooldown, tries again.
      yield* TestClock.adjust("45 seconds");
      yield* usage.probe;
      expect(calls).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("does not fall back to PATH agy when resolveExecutable rejects the binary", () =>
    Effect.gen(function* () {
      const profileDirectory = yield* createProfileWithCliToken();
      let calls = 0;

      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "oauth-personal",
        resolveExecutable: Effect.fail(
          new AntigravityCliUsageError({ reason: "resolve_executable" }),
        ),
        runCliUsage: () => {
          calls++;
          return Effect.succeed(SAMPLE_CLI_OUTPUT);
        },
      });

      const limits = yield* usage.probe;
      expect(calls).toBe(0);
      expect(limits.unavailable?.reason).toBe("probeFailed");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect(
    "returns unsupported without launching CLI for an unsigned-in oauth-personal profile",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profileDirectory = yield* fs.makeTempDirectoryScoped();
        let calls = 0;

        const usage = yield* makeAntigravityUsageProbe({
          profileDirectory,
          authMethod: "oauth-personal",
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
