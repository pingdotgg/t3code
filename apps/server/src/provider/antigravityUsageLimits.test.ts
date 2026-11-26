import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  antigravityCliUsageWindows,
  antigravityOutputShowsModelTurn,
  makeAntigravityUsageProbe,
} from "./antigravityUsageLimits.ts";

const SAMPLE_USAGE_STDOUT = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  duration_seconds: 0,
  num_turns: 0,
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              description: "You have used some of your weekly limit.",
              window: "weekly",
              remaining_fraction: 0.8182181119918823,
              reset_time: "2026-12-03T09:37:26Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              description: "You have used some of your 5-hour limit.",
              window: "5h",
              remaining_fraction: 0.5849005579948425,
              reset_time: "2026-11-27T00:37:26Z",
            },
            {
              id: "gemini-disabled",
              name: "Unmetered",
              window: "weekly",
              remaining_fraction: 1,
              disabled: true,
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
          ],
        },
      ],
    },
  },
});

function makeMockHandle(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly onKill?: () => void;
}): ChildProcessSpawner.ChildProcessHandle {
  const encoder = new TextEncoder();
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(42),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () =>
      Effect.sync(() => {
        input.onKill?.();
      }),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: input.stdout ? Stream.make(encoder.encode(input.stdout)) : Stream.empty,
    stderr: input.stderr ? Stream.make(encoder.encode(input.stderr)) : Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("antigravityCliUsageWindows", () => {
  it("maps agy /usage JSON output into native Antigravity windows with pace durations", () => {
    const requestedAt = Date.parse("2026-11-26T21:54:00.000Z");
    const windows = antigravityCliUsageWindows(
      `startup notice\n${SAMPLE_USAGE_STDOUT}\n`,
      requestedAt,
    );
    expect(windows).toBeDefined();
    expect(windows).toHaveLength(4);
    expect(windows?.[0]).toEqual({
      id: "gemini-weekly",
      label: "Gemini · Weekly",
      kind: "weekly",
      usedPercent: (1 - 0.8182181119918823) * 100,
      resetsAt: "2026-12-03T09:37:26.000Z",
      windowDurationMins: 10_080,
    });
    expect(windows?.[1]).toEqual({
      id: "gemini-5h",
      label: "Gemini · 5-hour",
      kind: "session",
      usedPercent: (1 - 0.5849005579948425) * 100,
      resetsAt: "2026-11-27T00:37:26.000Z",
      windowDurationMins: 300,
    });
    // Epoch-zero sentinel timestamps on full 100% pools are omitted.
    expect(windows?.[2]).toEqual({
      id: "3p-weekly",
      label: "Claude & GPT (shared) · Weekly",
      kind: "weekly",
      usedPercent: 0,
      windowDurationMins: 10_080,
    });
    expect(windows?.[3]).toEqual({
      id: "3p-5h",
      label: "Claude & GPT (shared) · 5-hour",
      kind: "session",
      usedPercent: 0,
      windowDurationMins: 300,
    });
  });

  it("omits rolling full-window reset timestamps on untouched pools", () => {
    const requestedAt = Date.parse("2026-11-26T22:00:00.000Z");
    const stdout = JSON.stringify({
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Argon",
              buckets: [
                {
                  id: "gemini-argon-5h",
                  window: "5h",
                  remaining_fraction: 1,
                  reset_time: "2026-11-27T03:00:00.000Z",
                },
              ],
            },
          ],
        },
      },
    });
    expect(antigravityCliUsageWindows(stdout, requestedAt)).toEqual([
      {
        id: "gemini-argon-5h",
        label: "Gemini Argon · 5-hour",
        kind: "session",
        usedPercent: 0,
        windowDurationMins: 300,
      },
    ]);
  });

  it("detects billed model turn envelopes so the probe can latch off", () => {
    expect(antigravityOutputShowsModelTurn(SAMPLE_USAGE_STDOUT)).toBe(false);
    expect(
      antigravityOutputShowsModelTurn(
        JSON.stringify({ status: "SUCCESS", num_turns: 1, conversation_id: "conv-1" }),
      ),
    ).toBe(true);
    expect(
      antigravityOutputShowsModelTurn(
        JSON.stringify({ status: "SUCCESS", num_turns: 0, conversation_id: "conv-2" }),
      ),
    ).toBe(true);
  });
});

describe("makeAntigravityUsageProbe", () => {
  it.effect("returns unsupported without spawning for API key auth methods", () =>
    Effect.gen(function* () {
      let spawns = 0;
      const spawner = ChildProcessSpawner.make(() => {
        spawns++;
        return Effect.succeed(makeMockHandle({ stdout: SAMPLE_USAGE_STDOUT }));
      });
      const probe = yield* makeAntigravityUsageProbe({
        authMethod: "gemini-api-key",
        baseEnv: {},
        resolveExecutable: Effect.succeed({
          executablePath: "/usr/bin/agy",
          source: "managed",
          version: "1.5.14",
          managedVersionDirectory: null,
        }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Layer.succeed(HostProcess.Platform, "linux"),
          ),
        ),
      );
      const limits = yield* probe.probe;
      expect(limits.unavailable?.reason).toBe("unsupported");
      expect(spawns).toBe(0);
    }),
  );

  it.effect(
    "reads limits via agy -p /usage, strips sensitive env vars, and caches within TTL",
    () =>
      Effect.gen(function* () {
        const calls: Array<{
          readonly command: string;
          readonly args: ReadonlyArray<string>;
          readonly env: Record<string, string | undefined>;
        }> = [];
        const spawner = ChildProcessSpawner.make((command) => {
          if (command._tag !== "StandardCommand") return Effect.die("Expected StandardCommand");
          calls.push({
            command: command.command,
            args: command.args.map(String),
            env: (command.options.env ?? {}) as Record<string, string | undefined>,
          });
          return Effect.succeed(makeMockHandle({ stdout: SAMPLE_USAGE_STDOUT }));
        });
        const usage = yield* makeAntigravityUsageProbe({
          authMethod: "oauth-personal",
          profileDirectory: "/tmp/t3-profile",
          baseEnv: {
            PATH: "/usr/bin",
            GEMINI_API_KEY: "secret",
            SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0",
            SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
            ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:9999",
          },
          resolveExecutable: Effect.succeed({
            executablePath: "/opt/agy",
            source: "managed",
            version: "1.5.14",
            managedVersionDirectory: null,
          }),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Layer.succeed(HostProcess.Platform, "linux"),
            ),
          ),
        );
        const first = yield* usage.probe;
        expect(first.unavailable).toBeUndefined();
        expect(first.windows.map((w) => w.id)).toEqual([
          "3p-5h",
          "gemini-5h",
          "3p-weekly",
          "gemini-weekly",
        ]);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.args).toEqual([
          "-p",
          "/usage",
          "--output-format",
          "json",
          "--print-timeout",
          "20s",
          "--log-file",
          "/dev/null",
        ]);
        expect(calls[0]?.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
        expect(calls[0]?.env.GEMINI_HOME).toBe("/tmp/t3-profile");
        expect(calls[0]?.env.GEMINI_API_KEY).toBeUndefined();
        expect(calls[0]?.env.SSH_CONNECTION).toBeUndefined();
        expect(calls[0]?.env.SSH_AUTH_SOCK).toBeUndefined();
        expect(calls[0]?.env.ANTIGRAVITY_LS_ADDRESS).toBeUndefined();

        // Subsequent probe within cache TTL does not respawn agy.
        const second = yield* usage.probe;
        expect(second).toEqual(first);
        expect(calls).toHaveLength(1);

        // Clearing cache allows a fresh read.
        yield* usage.clear;
        yield* usage.probe;
        expect(calls).toHaveLength(2);
      }),
  );

  it.effect("kills child and holds off polling when agy asks for interactive sign-in", () =>
    Effect.gen(function* () {
      let spawns = 0;
      let killed = false;
      const spawner = ChildProcessSpawner.make(() => {
        spawns++;
        return Effect.succeed(
          makeMockHandle({
            stderr:
              "Authentication required. Please visit the URL to log in:\nhttps://accounts.google.com/...",
            onKill: () => {
              killed = true;
            },
          }),
        );
      });
      const usage = yield* makeAntigravityUsageProbe({
        authMethod: "oauth-personal",
        baseEnv: {},
        resolveExecutable: Effect.succeed({
          executablePath: "/opt/agy",
          source: "managed",
          version: "1.5.14",
          managedVersionDirectory: null,
        }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Layer.succeed(HostProcess.Platform, "win32"),
          ),
        ),
      );
      const first = yield* usage.probe;
      expect(killed).toBe(true);
      expect(first.unavailable?.reason).toBe("probeFailed");
      expect(spawns).toBe(1);

      // Hold suppresses further spawns until clear().
      const second = yield* usage.probe;
      expect(second.unavailable?.reason).toBe("probeFailed");
      expect(spawns).toBe(1);

      yield* usage.clear;
      yield* usage.probe;
      expect(spawns).toBe(2);
    }),
  );

  it.effect("latches off permanently for a binary that executes /usage as a model turn", () =>
    Effect.gen(function* () {
      let spawns = 0;
      const spawner = ChildProcessSpawner.make(() => {
        spawns++;
        return Effect.succeed(
          makeMockHandle({
            stdout: JSON.stringify({
              status: "SUCCESS",
              conversation_id: "billed-conv-1",
              num_turns: 1,
              response: "Here is your usage...",
            }),
          }),
        );
      });
      const usage = yield* makeAntigravityUsageProbe({
        authMethod: "oauth-personal",
        baseEnv: {},
        resolveExecutable: Effect.succeed({
          executablePath: "/opt/agy",
          source: "managed",
          version: "1.5.14",
          managedVersionDirectory: null,
        }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Layer.succeed(HostProcess.Platform, "linux"),
          ),
        ),
      );
      const first = yield* usage.probe;
      expect(first.unavailable?.reason).toBe("unsupported");
      expect(spawns).toBe(1);

      // Even after clear(), the same binary remains latched off.
      yield* usage.clear;
      const second = yield* usage.probe;
      expect(second.unavailable?.reason).toBe("unsupported");
      expect(spawns).toBe(1);
    }),
  );

  it.effect("retries transient --version failures instead of caching unsupported forever", () =>
    Effect.gen(function* () {
      let versionCalls = 0;
      const spawner = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return Effect.die("Expected StandardCommand");
        if (command.args[0] === "--version") {
          versionCalls++;
          return versionCalls === 1
            ? Effect.succeed(makeMockHandle({ exitCode: 1, stderr: "transient error" }))
            : Effect.succeed(makeMockHandle({ exitCode: 0, stdout: "agy 1.5.14\n" }));
        }
        return Effect.succeed(makeMockHandle({ stdout: SAMPLE_USAGE_STDOUT }));
      });
      const usage = yield* makeAntigravityUsageProbe({
        authMethod: "oauth-personal",
        baseEnv: {},
        resolveExecutable: Effect.succeed({
          executablePath: "/usr/local/bin/agy",
          source: "path",
          version: null,
          managedVersionDirectory: null,
        }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Layer.succeed(HostProcess.Platform, "linux"),
          ),
        ),
      );
      const first = yield* usage.probe;
      expect(first.unavailable?.reason).toBe("probeFailed");
      expect(versionCalls).toBe(1);

      const second = yield* usage.probe;
      expect(second.unavailable).toBeUndefined();
      expect(second.windows).toHaveLength(4);
      expect(versionCalls).toBe(2);
    }),
  );
});
