import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import {
  AntigravityCliUsageError,
  antigravityAccountFingerprint,
  antigravityEmailFingerprint,
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

  it("resolves cursor-positioned in-place percentage overwrites without repeating Models & Quota", () => {
    const nowMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T17:00:00.000Z"));
    const inPlaceRedraw =
      "\x1b[2J\x1b[1;1HModels & Quota  Account: user@example.com" +
      "\x1b[3;1HGEMINI MODELS" +
      "\x1b[5;1HFive Hour Limit Remaining" +
      "\x1b[6;1H[████] 95.00%" +
      "\x1b[7;1HRefreshes in 1d 2h" +
      "\x1b[6;8H50.00%\x1b[K";
    const parsed = parseAntigravityCliUsageOutput(inPlaceRedraw, nowMs);
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

  it("clamps extreme CSI CUP and CHA column parameters so screen memory stays bounded", () => {
    const nowMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T17:00:00.000Z"));
    const hostile =
      "\x1b[1;99999999HX\x1b[99999999GY" +
      "\x1b[2J\x1b[1;1HModels & Quota  Account: user@example.com" +
      "\x1b[3;1HGEMINI MODELS\x1b[5;1HFive Hour Limit Remaining\x1b[6;1H[████] 75.00%";
    const parsed = parseAntigravityCliUsageOutput(hostile, nowMs);
    expect(parsed?.windows).toHaveLength(1);
    expect(parsed?.windows[0]?.usedPercent).toBe(25);
  });

  it("returns undefined when output has no quota groups", () => {
    const nowMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T17:00:00.000Z"));
    expect(parseAntigravityCliUsageOutput("Antigravity CLI 1.5.16", nowMs)).toBeUndefined();
  });
});

describe("antigravityAccountFingerprint / antigravityEmailFingerprint", () => {
  it.effect("matches local CLI email fingerprint when hub userinfo provides email", () =>
    Effect.gen(function* () {
      const cliFp = yield* antigravityEmailFingerprint("user@example.com");
      const hubFp = yield* antigravityAccountFingerprint({
        id: "google-42",
        email: " User@Example.com ",
      });
      const idOnlyFp = yield* antigravityAccountFingerprint({ id: "google-42" });
      expect(hubFp).toBe(cliFp);
      expect(idOnlyFp).toBe("136d4952771fd67a3600053f37492cbd05828712e0b1c89ebab03d4c22ab6554");
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

describe("buildAntigravityCliUsageEnv", () => {
  it("strips ambient Google/ADC credentials and launcher internals case-insensitively", () => {
    const cleaned = buildAntigravityCliUsageEnv(
      {
        PATH: "/usr/local/bin",
        GEMINI_API_KEY: "ambient-gemini-key",
        google_api_key: "ambient-google-key",
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/creds.json",
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        GOOGLE_CLOUD_PROJECT: "ambient-project",
        AGY_ADC_AUTH: "true",
        agy_adc_auth: "1",
        GEMINI_HOME: "/persistent/profile",
        SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0",
        AGY_ACP_FORCE_FILE_STORAGE: "1",
        AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1",
        ELECTRON_RUN_AS_NODE: "1",
      },
      {
        isolatedHome: "/tmp/iso-home",
        isolatedGeminiHome: "/tmp/iso-home/.gemini",
        gcpProject: "configured-project",
        gcpLocation: "us-central1",
      },
    );
    expect(cleaned).toEqual({
      PATH: "/usr/local/bin",
      HOME: "/tmp/iso-home",
      USERPROFILE: "/tmp/iso-home",
      GEMINI_HOME: "/tmp/iso-home/.gemini",
      GOOGLE_CLOUD_PROJECT: "configured-project",
      GOOGLE_CLOUD_LOCATION: "us-central1",
      TERM: "xterm-256color",
    });
  });
});

describe("runOfficialAgyUsagePty", () => {
  it.effect(
    "waits for banner, sends /usage, captures quota output, and awaits exit on teardown",
    () =>
      Effect.gen(function* () {
        const writes: string[] = [];
        let killed = false;
        let exitedReported = false;
        let onDataHandler: ((chunk: string) => void) | undefined;
        let onExitHandler: (() => void) | undefined;

        const fakePtyModule: AntigravityNodePtyModule = {
          spawn: () =>
            ({
              onData: (cb: (chunk: string) => void) => {
                onDataHandler = cb;
                queueMicrotask(() => cb("Antigravity CLI 1.5.16\n"));
                return { dispose: () => {} };
              },
              onExit: (cb: () => void) => {
                onExitHandler = cb;
                return { dispose: () => {} };
              },
              write: (data: string) => {
                writes.push(data);
                if (data === "\r") {
                  queueMicrotask(() => onDataHandler?.(SAMPLE_CLI_OUTPUT));
                }
              },
              kill: () => {
                killed = true;
                queueMicrotask(() => {
                  exitedReported = true;
                  onExitHandler?.();
                });
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
        expect(exitedReported).toBe(true);
      }),
  );

  it.effect("completes a single-window quota summary promptly within the outer probe timeout", () =>
    Effect.gen(function* () {
      let onDataHandler: ((chunk: string) => void) | undefined;
      let onExitHandler: (() => void) | undefined;
      const fakePtyModule: AntigravityNodePtyModule = {
        spawn: () =>
          ({
            onData: (cb: (chunk: string) => void) => {
              onDataHandler = cb;
              queueMicrotask(() => cb("Antigravity CLI 1.5.16\n"));
              return { dispose: () => {} };
            },
            onExit: (cb: () => void) => {
              onExitHandler = cb;
              return { dispose: () => {} };
            },
            write: (data: string) => {
              if (data === "\r") {
                queueMicrotask(() => onDataHandler?.(SECOND_ACCOUNT_CLI_OUTPUT));
              }
            },
            kill: () => {
              queueMicrotask(() => onExitHandler?.());
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

      yield* TestClock.adjust("6 seconds");
      const output = yield* Fiber.join(fiber);
      const parsed = parseAntigravityCliUsageOutput(output, 0);
      expect(parsed?.windows).toHaveLength(1);
      expect(parsed?.windows[0]?.usedPercent).toBe(50);
    }),
  );

  it.effect(
    "aborts with AntigravityCliUsageError(output_limit_exceeded) even if a valid frame preceded the overflow",
    () =>
      Effect.gen(function* () {
        let killed = false;
        let onDataHandler: ((chunk: string) => void) | undefined;
        let onExitHandler: (() => void) | undefined;
        const fakePtyModule: AntigravityNodePtyModule = {
          spawn: () =>
            ({
              onData: (cb: (chunk: string) => void) => {
                onDataHandler = cb;
                queueMicrotask(() => cb("Antigravity CLI 1.5.16\n"));
                return { dispose: () => {} };
              },
              onExit: (cb: () => void) => {
                onExitHandler = cb;
                return { dispose: () => {} };
              },
              write: (data: string) => {
                if (data === "\r") {
                  queueMicrotask(() => {
                    onDataHandler?.(SAMPLE_CLI_OUTPUT);
                    onDataHandler?.("x".repeat(300 * 1024));
                  });
                }
              },
              kill: () => {
                killed = true;
                queueMicrotask(() => onExitHandler?.());
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
        ).pipe(Effect.scoped, Effect.flip, Effect.forkChild);

        yield* TestClock.adjust("5 seconds");
        const error = yield* Fiber.join(fiber);
        expect(error).toBeInstanceOf(AntigravityCliUsageError);
        expect(error.reason).toBe("output_limit_exceeded");
        expect(killed).toBe(true);
      }),
  );
});

describe("makeAntigravityUsageProbe (official CLI)", () => {
  it.effect(
    "caches for 5m while preserving original checkedAt, isolates HOME/GEMINI_HOME with empty MCP/hooks, and holds executable lease",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const startMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T17:00:00Z"));
        yield* TestClock.setTime(startMs);
        const profileDirectory = yield* createProfileWithCliToken();
        const invocations: AntigravityCliUsageRunInput[] = [];
        let leaseReleasedDuringRun = false;
        let leaseReleasedAfterRun = false;

        const usage = yield* makeAntigravityUsageProbe({
          profileDirectory,
          authMethod: "oauth-personal",
          resolveExecutable: Effect.acquireRelease(Effect.succeed("/usr/local/bin/agy"), () =>
            Effect.sync(() => {
              leaseReleasedAfterRun = true;
            }),
          ),
          environment: {
            PATH: "/usr/local/bin",
            ELECTRON_RUN_AS_NODE: "1",
            GEMINI_API_KEY: "must-be-stripped",
            AGY_ADC_AUTH: "true",
          },
          runCliUsage: (args) =>
            Effect.gen(function* () {
              invocations.push(args);
              leaseReleasedDuringRun = leaseReleasedAfterRun;
              const isolatedGemini = args.env.GEMINI_HOME ?? "";
              expect(isolatedGemini).toBe(path.join(args.cwd, ".gemini"));
              const mcpConfig = yield* fs
                .readFileString(path.join(isolatedGemini, "config", "mcp_config.json"))
                .pipe(Effect.orElseSucceed(() => ""));
              const hooksConfig = yield* fs
                .readFileString(path.join(isolatedGemini, "config", "hooks.json"))
                .pipe(Effect.orElseSucceed(() => ""));
              expect(mcpConfig).toBe('{"mcpServers":{}}');
              expect(hooksConfig).toBe("{}");
              return SAMPLE_CLI_OUTPUT;
            }),
        });

        const first = yield* usage.probe;
        const expectedFingerprint = yield* antigravityEmailFingerprint("user@example.com");
        expect(invocations).toHaveLength(1);
        expect(leaseReleasedDuringRun).toBe(false);
        expect(leaseReleasedAfterRun).toBe(true);
        expect(invocations[0]?.executablePath).toBe("/usr/local/bin/agy");
        expect(invocations[0]?.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
        expect(invocations[0]?.env.GEMINI_API_KEY).toBeUndefined();
        expect(invocations[0]?.env.AGY_ADC_AUTH).toBeUndefined();
        expect(invocations[0]?.env.HOME).toBe(invocations[0]?.cwd);
        expect(invocations[0]?.env.GEMINI_HOME).not.toBe(profileDirectory);
        expect(first.unavailable).toBeUndefined();
        expect(first.windows).toHaveLength(4);
        expect(first.credentialFingerprint).toBe(expectedFingerprint);
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

  it.effect("deduplicates concurrent probe calls so only one CLI process runs", () =>
    Effect.gen(function* () {
      const startMs = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T17:00:00Z"));
      yield* TestClock.setTime(startMs);
      const profileDirectory = yield* createProfileWithCliToken();
      const gate = yield* Deferred.make<void>();
      let calls = 0;

      const usage = yield* makeAntigravityUsageProbe({
        profileDirectory,
        authMethod: "oauth-personal",
        runCliUsage: () =>
          Effect.gen(function* () {
            calls++;
            yield* Deferred.await(gate);
            return SAMPLE_CLI_OUTPUT;
          }),
      });

      const firstFiber = yield* Effect.forkChild(usage.probe);
      const secondFiber = yield* Effect.forkChild(usage.probe);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);

      const [first, second] = yield* Effect.all([Fiber.join(firstFiber), Fiber.join(secondFiber)]);
      expect(calls).toBe(1);
      expect(first.unavailable).toBeUndefined();
      expect(second.unavailable).toBeUndefined();
      expect(second.checkedAt).toBe(first.checkedAt);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect(
    "allows keyring-only oauth-business instances (without plaintext token file) and forwards GCP project/location",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profileDirectory = yield* fs.makeTempDirectoryScoped();
        const invocations: AntigravityCliUsageRunInput[] = [];

        const usage = yield* makeAntigravityUsageProbe({
          profileDirectory,
          authMethod: "oauth-business",
          gcpProject: "enterprise-proj",
          gcpLocation: "us-central1",
          runCliUsage: (args) => {
            invocations.push(args);
            return Effect.succeed(SAMPLE_CLI_OUTPUT);
          },
        });

        const limits = yield* usage.probe;
        expect(limits.unavailable).toBeUndefined();
        expect(invocations).toHaveLength(1);
        expect(invocations[0]?.args).toEqual(["--project", "enterprise-proj"]);
        expect(invocations[0]?.env.GOOGLE_CLOUD_PROJECT).toBe("enterprise-proj");
        expect(invocations[0]?.env.GOOGLE_CLOUD_LOCATION).toBe("us-central1");
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

      yield* TestClock.adjust("20 seconds");
      const second = yield* usage.probe;
      expect(calls).toBe(1);
      expect(second.unavailable?.reason).toBe("probeFailed");

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
