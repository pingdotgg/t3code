import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { ChildProcessSpawner } from "effect/process";

import * as JjProcess from "./JjProcess.ts";
import * as VcsProcess from "./VcsProcess.ts";

const GLOBAL_ARGS = [
  "--no-pager",
  "--color=never",
  "--quiet",
  "--config",
  "git.abandon-unreachable-commits=false",
];

const output = (
  overrides: Partial<VcsProcess.VcsProcessOutput> = {},
): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

const recordingProcess = (
  calls: VcsProcess.VcsProcessInput[],
  reply: (input: VcsProcess.VcsProcessInput, callIndex: number) => VcsProcess.VcsProcessOutput,
) =>
  Layer.mock(VcsProcess.VcsProcess)({
    run: (input) =>
      Effect.sync(() => {
        const callIndex = calls.length;
        calls.push(input);
        return reply(input, callIndex);
      }),
  });

describe("jjCommand", () => {
  it.effect("puts the abandon guard in the prefix of every invocation", () => {
    const calls: VcsProcess.VcsProcessInput[] = [];

    return Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      yield* JjProcess.jjCommand(process, "test.read", "/repo", ["log", "-r", "@"], {
        ignoreWorkingCopy: true,
      });
      yield* JjProcess.jjCommand(process, "test.write", "/repo", ["git", "fetch"]);

      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.equal(call.command, "jj");
        assert.deepStrictEqual(call.args.slice(0, GLOBAL_ARGS.length), GLOBAL_ARGS);
        assert.equal(call.cwd, "/repo");
        assert.equal(call.spawnCwd, undefined);
      }
      assert.deepStrictEqual(calls[0]?.args.slice(GLOBAL_ARGS.length), [
        "--ignore-working-copy",
        "log",
        "-r",
        "@",
      ]);
      assert.deepStrictEqual(calls[1]?.args.slice(GLOBAL_ARGS.length), ["git", "fetch"]);
    }).pipe(Effect.provide(recordingProcess(calls, () => output())));
  });

  for (const command of ["fetch", "push"]) {
    it.effect(`preserves Git's authentication policy for git ${command}, including retries`, () => {
      const calls: VcsProcess.VcsProcessInput[] = [];

      return Effect.gen(function* () {
        const process = yield* VcsProcess.VcsProcess;
        yield* JjProcess.jjCommand(process, "test.remote", "/repo", ["git", command], {
          env: { CUSTOM: "preserved", GIT_TERMINAL_PROMPT: "1" },
        });

        const remoteCalls = calls.filter((call) => call.args.includes(command));
        assert.equal(remoteCalls.length, 2);
        for (const call of remoteCalls) {
          assert.deepStrictEqual(
            call.env,
            command === "fetch"
              ? {
                  CUSTOM: "preserved",
                  GCM_INTERACTIVE: "never",
                  GIT_ASKPASS: "",
                  GIT_TERMINAL_PROMPT: "0",
                  SSH_ASKPASS: "",
                  SSH_ASKPASS_REQUIRE: "never",
                }
              : { CUSTOM: "preserved", GIT_TERMINAL_PROMPT: "1" },
          );
        }
      }).pipe(
        Effect.provide(
          recordingProcess(calls, (_input, callIndex) =>
            callIndex === 0
              ? output({
                  exitCode: ChildProcessSpawner.ExitCode(1),
                  stderr: "Error: The working copy is stale.",
                })
              : output(),
          ),
        ),
      );
    });
  }

  it.effect("preserves the environment for local commands", () => {
    const calls: VcsProcess.VcsProcessInput[] = [];
    return Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      yield* JjProcess.jjCommand(process, "test.local", "/repo", ["log"], {
        env: { GIT_TERMINAL_PROMPT: "1" },
      });
      assert.deepStrictEqual(calls[0]?.env, { GIT_TERMINAL_PROMPT: "1" });
    }).pipe(Effect.provide(recordingProcess(calls, () => output())));
  });

  for (const operation of ["currentSegment", "countRevset"]) {
    for (const [stderr, failureKind] of [
      ["Error: Revision `missing` doesn't exist", "not-found"],
      ["Error: Function `trnk` doesn't exist", "command-failed"],
      ['Error: There is no jj repo in "/repo"', "command-failed"],
      ["Error: authentication failed", "authentication"],
      ["Error: the operation log is unreadable", "command-failed"],
    ] as const) {
      it.effect(`${operation} classifies ${JSON.stringify(stderr)}`, () => {
        const calls: VcsProcess.VcsProcessInput[] = [];
        return Effect.gen(function* () {
          const process = yield* VcsProcess.VcsProcess;
          const error = yield* JjProcess.jjCommand(
            process,
            `JjVcsDriver.${operation}`,
            "/repo",
            ["log", "-r", "@"],
            { readingChange: true },
          ).pipe(Effect.flip);
          assert.equal(error._tag, "VcsProcessExitError");
          if (error._tag === "VcsProcessExitError") {
            assert.equal(error.failureKind, failureKind);
          }
        }).pipe(
          Effect.provide(
            recordingProcess(calls, () =>
              output({ exitCode: ChildProcessSpawner.ExitCode(1), stderr }),
            ),
          ),
        );
      });
    }
  }

  it.effect("places per-call config flags before the command arguments", () => {
    const calls: VcsProcess.VcsProcessInput[] = [];

    return Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      yield* JjProcess.jjCommand(process, "test.config", "/repo", ["status"], {
        config: [["ui.editor", "false"]],
        ignoreWorkingCopy: true,
      });

      assert.deepStrictEqual(calls[0]?.args, [
        ...GLOBAL_ARGS,
        "--config",
        "ui.editor=false",
        "--ignore-working-copy",
        "status",
      ]);
    }).pipe(Effect.provide(recordingProcess(calls, () => output())));
  });

  it.effect("updates a stale workspace and retries the command exactly once", () => {
    const calls: VcsProcess.VcsProcessInput[] = [];

    return Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      const result = yield* JjProcess.jjCommand(process, "test.stale", "/repo", ["status"]);

      assert.equal(result.stdout, "recovered");
      assert.deepStrictEqual(
        calls.map((call) => call.args.slice(GLOBAL_ARGS.length).join(" ")),
        ["status", "workspace update-stale", "status"],
      );
    }).pipe(
      Effect.provide(
        recordingProcess(calls, (_input, callIndex) =>
          callIndex === 0
            ? output({
                exitCode: ChildProcessSpawner.ExitCode(1),
                stderr: "Error: The working copy is stale (not updated since operation abc).",
              })
            : output({ stdout: callIndex === 2 ? "recovered" : "" }),
        ),
      ),
    );
  });

  it.effect("propagates a second stale failure instead of retrying again", () => {
    const calls: VcsProcess.VcsProcessInput[] = [];

    return Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      const error = yield* JjProcess.jjCommand(process, "test.stale", "/repo", ["status"]).pipe(
        Effect.flip,
      );

      assert.equal(error._tag, "VcsProcessExitError");
      assert.equal(calls.length, 3);
    }).pipe(
      Effect.provide(
        recordingProcess(calls, () =>
          output({
            exitCode: ChildProcessSpawner.ExitCode(1),
            stderr: "Error: The working copy is stale.",
          }),
        ),
      ),
    );
  });

  it.effect("classifies a missing jj repository as not-found", () => {
    const calls: VcsProcess.VcsProcessInput[] = [];

    return Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      const error = yield* JjProcess.jjCommand(process, "JjVcsDriver.changeAt", "/repo", [
        "status",
      ]).pipe(Effect.flip);

      assert.equal(error._tag, "VcsProcessExitError");
      assert.equal(error._tag === "VcsProcessExitError" ? error.failureKind : null, "not-found");
    }).pipe(
      Effect.provide(
        recordingProcess(calls, () =>
          output({
            exitCode: ChildProcessSpawner.ExitCode(1),
            stderr: 'Error: There is no jj repo in "/repo"',
          }),
        ),
      ),
    );
  });

  it.effect("logs the large-file refusal banner without failing the command", () => {
    const calls: VcsProcess.VcsProcessInput[] = [];
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });

    return Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      const result = yield* JjProcess.jjCommand(process, "test.banner", "/repo", ["status"]);

      assert.equal(result.exitCode, 0);
      assert.equal(
        messages.filter((message) => message.includes("refused to snapshot some files")).length,
        1,
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          recordingProcess(calls, () =>
            output({
              stderr:
                "Warning: Refused to snapshot some files:\n  big.bin: 3.0MiB; the maximum size allowed is 1.0MiB\n",
            }),
          ),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });
});

describe("colocatedGitCommand", () => {
  for (const command of ["fetch", "push"]) {
    it.effect(`preserves Git's authentication policy for raw ${command}`, () => {
      const calls: VcsProcess.VcsProcessInput[] = [];
      return Effect.gen(function* () {
        const process = yield* VcsProcess.VcsProcess;
        yield* JjProcess.colocatedGitCommand(
          process,
          "test.remote",
          { gitDir: "/repo/.git", cwd: "/repo" },
          [command, "origin"],
          { env: { CUSTOM: "preserved", GIT_TERMINAL_PROMPT: "1" } },
        );
        assert.deepStrictEqual(
          calls[0]?.env,
          command === "fetch"
            ? {
                CUSTOM: "preserved",
                GCM_INTERACTIVE: "never",
                GIT_ASKPASS: "",
                GIT_TERMINAL_PROMPT: "0",
                SSH_ASKPASS: "",
                SSH_ASKPASS_REQUIRE: "never",
              }
            : { CUSTOM: "preserved", GIT_TERMINAL_PROMPT: "1" },
        );
      }).pipe(Effect.provide(recordingProcess(calls, () => output())));
    });
  }

  it.effect("does not infer checkpoint retry policy from the operation name", () => {
    const calls: VcsProcess.VcsProcessInput[] = [];
    return Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      yield* JjProcess.colocatedGitCommand(
        process,
        VcsProcess.JJ_CHECKPOINT_CAPTURE_OPERATION,
        { gitDir: "/repo/.git", cwd: "/repo" },
        ["update-ref", "refs/t3/checkpoints/test", "HEAD"],
      );
      assert.isTrue(calls[0]?.allowNonZeroExit);
    }).pipe(Effect.provide(recordingProcess(calls, () => output())));
  });

  it.effect("keeps checkpoint retry policy in VcsProcess", () => {
    const calls: VcsProcess.VcsProcessInput[] = [];
    return Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      yield* JjProcess.colocatedGitCommand(
        process,
        VcsProcess.JJ_CHECKPOINT_CAPTURE_OPERATION,
        { gitDir: "/repo/.git", cwd: "/repo" },
        ["add", "-A"],
        { retryTransientFailures: true },
      );
      assert.equal(calls[0]?.allowNonZeroExit, false);
    }).pipe(Effect.provide(recordingProcess(calls, () => output())));
  });

  it.effect("retries transient checkpoint Git failures through the colocated command", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const process = yield* VcsProcess.make.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.sync(() => {
              attempts += 1;
              return {
                stdout: "",
                stderr:
                  attempts === 1 ? "fatal: Unable to create '/repo/index.lock': File exists" : "",
                code: ChildProcessSpawner.ExitCode(attempts === 1 ? 1 : 0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
        }),
      );
      const fiber = yield* JjProcess.colocatedGitCommand(
        process,
        VcsProcess.JJ_CHECKPOINT_CAPTURE_OPERATION,
        { gitDir: "/repo/.git", cwd: "/repo" },
        ["add", "-A"],
        { retryTransientFailures: true },
      ).pipe(Effect.forkScoped);
      yield* TestClock.adjust("150 millis");
      const result = yield* Fiber.join(fiber);
      assert.equal(result.exitCode, 0);
      assert.equal(attempts, 2);
    }),
  );

  it.effect("falls back to writeout-only when macOS rejects a checkpoint's full fsync", () =>
    Effect.gen(function* () {
      const fsyncMethods: Array<string | undefined> = [];
      const process = yield* VcsProcess.make.pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) =>
            Effect.sync(() => {
              const method = input.args.find((arg) => arg.startsWith("core.fsyncMethod="));
              fsyncMethods.push(method);
              const failed = method === "core.fsyncMethod=fsync";
              return {
                stdout: "",
                stderr: failed
                  ? "fatal: fsync error on '.git/objects/a5/tmp_obj_Pseg66': Operation not supported"
                  : "",
                code: ChildProcessSpawner.ExitCode(failed ? 128 : 0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
        }),
      );
      const result = yield* JjProcess.colocatedGitCommand(
        process,
        VcsProcess.JJ_CHECKPOINT_CAPTURE_OPERATION,
        { gitDir: "/repo/.git", cwd: "/repo" },
        [
          "-c",
          "core.fsync=objects,reference",
          "-c",
          "core.fsyncMethod=fsync",
          "update-ref",
          "refs/t3/checkpoints/x",
          "HEAD",
        ],
        { retryTransientFailures: true },
      );
      assert.equal(result.exitCode, 0);
      assert.deepStrictEqual(fsyncMethods, [
        "core.fsyncMethod=fsync",
        "core.fsyncMethod=writeout-only",
      ]);
    }),
  );

  it.effect("always passes an explicit git directory and spawns in the given cwd", () => {
    const calls: VcsProcess.VcsProcessInput[] = [];

    return Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      yield* JjProcess.colocatedGitCommand(
        process,
        "test.git",
        { gitDir: "/repo/.git", workTree: "/ws", cwd: "/ws" },
        ["check-ignore", "--stdin"],
      );

      assert.equal(calls[0]?.command, "git");
      assert.deepStrictEqual(calls[0]?.args, [
        "--git-dir",
        "/repo/.git",
        "--work-tree",
        "/ws",
        "check-ignore",
        "--stdin",
      ]);
      assert.equal(calls[0]?.cwd, "/ws");
      assert.equal(calls[0]?.spawnCwd, undefined);
    }).pipe(Effect.provide(recordingProcess(calls, () => output())));
  });
});
