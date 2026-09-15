import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { ChildProcessSpawner } from "effect/unstable/process";

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
      const error = yield* JjProcess.jjCommand(process, "test.missing", "/repo", ["status"]).pipe(
        Effect.flip,
      );

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
