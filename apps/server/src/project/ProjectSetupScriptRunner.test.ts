import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as TerminalManager from "../terminal/Manager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

it.effect("resolves setup scripts through the standalone project service", () => {
  const open = vi.fn((input: Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0]) =>
    Effect.succeed({
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      worktreePath: input.worktreePath ?? null,
      status: "running" as const,
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      label: "Shell",
      updatedAt: "2026-06-20T00:00:00.000Z",
    }),
  );
  const write = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) => Effect.void,
  );
  const closeIdle = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["closeIdle"]>[0]) => Effect.void,
  );
  const listeners: Array<Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]> =
    [];
  const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.push(listener);
      return () => undefined;
    });
  const projectId = ProjectId.make("project:setup-runner-v2");
  const project = {
    id: projectId,
    title: "Project",
    workspaceRoot: "/repo",
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    scripts: [
      {
        id: "setup",
        name: "Setup",
        command: "vp install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "clean",
        name: "Clean",
        command: "cargo clean",
        icon: "build" as const,
        runOnWorktreeCreate: false,
        runOnSettle: true,
      },
    ],
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    deletedAt: null,
  };
  const layer = ProjectSetupScriptRunner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some(project)),
        }),
        Layer.mock(TerminalManager.TerminalManager)({ open, write, subscribe, closeIdle }),
        ServerSettings.layerTest(),
        NodeCrypto.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const result = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
    });
    assert.deepEqual(result, {
      status: "started",
      async: true,
      scriptId: "setup",
      scriptName: "Setup",
      scriptCommand: "vp install",
      terminalId: "setup-setup",
      cwd: "/repo-worktree",
    });
    assert.equal(open.mock.calls[0]?.[0].cwd, "/repo-worktree");
    assert.deepEqual(open.mock.calls[0]?.[0].env, {
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo-worktree",
      COLORTERM: "",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    });
    assert.equal(write.mock.calls[0]?.[0].data, "vp install\r");
    const lines: string[] = [];
    const observed = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      observeCompletion: {
        onOutputLine: (line) =>
          Effect.sync(() => {
            lines.push(line);
          }),
      },
    });
    assert.equal(observed.status, "started");
    const listener = listeners[0]!;
    yield* listener({
      type: "output",
      threadId: "thread-1",
      terminalId: "setup-setup",
      data: "Downloading 10%\rDownloading 20%\r\nDone\n",
    });
    assert.deepEqual(lines, ["Downloading 10%", "Downloading 20%", "Done"]);
    yield* listener({ type: "closed", threadId: "thread-1", terminalId: "setup-setup" });

    const settle = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      trigger: "settle",
    });
    const settleTerminalId = settle.status === "started" ? settle.terminalId : "";
    assert.match(settleTerminalId, /^settle-clean-/);
    assert.equal(write.mock.calls.at(-1)?.[0].data, "cargo clean\r");

    // A clean run closes its shell once the prompt is back, not at the
    // sentinel, so the prompt redraw is not taken for new activity.
    const observedSettle = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      trigger: "settle",
      observeCompletion: {},
    });
    const observedTerminalId = observedSettle.status === "started" ? observedSettle.terminalId : "";
    // Each settle gets its own shell, so a busy one is never typed into.
    assert.notEqual(observedTerminalId, settleTerminalId);
    const token = /__T3_SETUP_DONE___(\w+):/.exec(write.mock.calls.at(-1)?.[0].data ?? "")?.[1];
    const settleListener = listeners.at(-1)!;
    const completion = yield* Effect.forkChild(
      observedSettle.status === "started" && observedSettle.completion
        ? observedSettle.completion
        : Effect.die("no completion"),
    );
    yield* settleListener({
      type: "output",
      threadId: "thread-1",
      terminalId: observedTerminalId,
      data: `\r\n__T3_SETUP_DONE___${token}:0\r\n`,
    });
    yield* Effect.yieldNow;
    assert.equal(closeIdle.mock.calls.length, 0);
    yield* settleListener({
      type: "output",
      threadId: "thread-1",
      terminalId: observedTerminalId,
      data: "$ ",
    });
    assert.deepEqual((yield* Fiber.join(completion)).exitCode, 0);
    assert.deepEqual(closeIdle.mock.calls[0]?.[0], {
      threadId: "thread-1",
      terminalId: observedTerminalId,
    });
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  {
    name: "multiline commands with quotes, backslashes and Unicode",
    command:
      "printf '%s\\n' \"it's ready\" 'literal \\n $(printf wrong) `printf wrong` café'\nprintf '%s\\n' done # trailing comment",
    output: "it's ready\nliteral \\n $(printf wrong) `printf wrong` café\ndone\n",
    exitCode: 0,
  },
  {
    name: "heredocs",
    command: "cat <<'END'\nline one\n$literal \\n café\nEND",
    output: "line one\n$literal \\n café\n",
    exitCode: 0,
  },
  {
    name: "Windows line endings",
    command: "printf '%s\\n' first\r\nprintf '%s\\n' second",
    output: "first\nsecond\n",
    exitCode: 0,
  },
  {
    name: "commands that read stdin",
    command: "read value\nprintf '%s\\n' \"$value\"",
    input: "from stdin\n",
    output: "from stdin\n",
    exitCode: 0,
  },
  {
    name: "explicit exits",
    command: "printf '%s\\n' failed\nexit 7",
    output: "failed\n",
    exitCode: 7,
  },
  {
    name: "syntax errors",
    command: "if then",
    output: "",
    exitCode: null,
  },
])("reports completion when a line editor submits $name", ({ command, input, output, exitCode }) =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    let listener: Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0];
    let sentinel = "";
    let reportedExitCode = 0;
    const lines: string[] = [];
    const closeIdle = vi.fn(() => Effect.void);
    const layer = ProjectSetupScriptRunner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(TerminalManager.TerminalManager)({
            open: (input) =>
              Effect.succeed({
                threadId: input.threadId,
                terminalId: input.terminalId,
                cwd: input.cwd,
                worktreePath: input.worktreePath ?? null,
                status: "running" as const,
                pid: 123,
                history: "",
                exitCode: null,
                exitSignal: null,
                label: "Shell",
                updatedAt: "2026-06-20T00:00:00.000Z",
              }),
            subscribe: (callback) =>
              Effect.sync(() => {
                listener = callback;
                return () => undefined;
              }),
            write: (write) =>
              Effect.gen(function* () {
                const submitted = write.data.split("\r");
                assert.equal(submitted.pop(), "");
                assert.equal(submitted.length, 1);
                sentinel = /(__T3_SETUP_DONE___\w+:)/.exec(write.data)?.[1] ?? "";
                assert.notEqual(sentinel, "");
                yield* listener({
                  type: "output",
                  threadId: write.threadId,
                  terminalId: write.terminalId,
                  data: `${write.data}\n`,
                });
                const stdout = yield* spawner
                  .string(
                    ChildProcess.make("/bin/sh", ["-c", submitted[0]!], {
                      stdin: Stream.make(new TextEncoder().encode(input ?? "")),
                    }),
                  )
                  .pipe(Effect.orDie);
                const completion = stdout.slice(output.length);
                assert.match(completion, new RegExp(`^\\n${sentinel}\\d+\\n$`));
                reportedExitCode = Number(completion.slice(sentinel.length + 1).trim());
                if (exitCode === null) assert.notEqual(reportedExitCode, 0);
                else assert.equal(reportedExitCode, exitCode);
                assert.equal(stdout, `${output}\n${sentinel}${reportedExitCode}\n`);
                yield* listener({
                  type: "output",
                  threadId: write.threadId,
                  terminalId: write.terminalId,
                  data: stdout,
                });
                yield* listener({
                  type: "output",
                  threadId: write.threadId,
                  terminalId: write.terminalId,
                  data: "$ ",
                });
              }),
            closeIdle,
          }),
          ServerSettings.layerTest(),
          NodeCrypto.layer,
          Layer.succeed(HostProcess.Platform, "linux"),
          Layer.succeed(HostProcess.Environment, { SHELL: "/bin/sh" }),
        ),
      ),
    );

    return yield* Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-setup",
        worktreePath: "/repo-worktree",
        project: {
          id: ProjectId.make("project-setup"),
          workspaceRoot: "/repo",
          scripts: [
            {
              id: "setup",
              name: "Setup",
              command,
              icon: "configure",
              runOnWorktreeCreate: true,
              async: false,
            },
          ],
        },
        observeCompletion: {
          onOutputLine: (line) => Effect.sync(() => lines.push(line)).pipe(Effect.asVoid),
        },
      });
      assert.equal(result.status, "started");
      if (result.status !== "started" || !result.completion)
        return yield* Effect.die("no completion");
      assert.equal((yield* result.completion).exitCode, reportedExitCode);
      assert.deepEqual(lines, output.trimEnd().split("\n").filter(Boolean));
      assert.equal(closeIdle.mock.calls.length, exitCode === 0 ? 1 : 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);
