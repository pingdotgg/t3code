import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, vi } from "@effect/vitest";
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
    assert.equal(write.mock.calls[0]?.[0].data, " vp install\r");
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
    assert.match(write.mock.calls[1]?.[0].data ?? "", /^ \S/);
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
    assert.equal(write.mock.calls.at(-1)?.[0].data, " cargo clean\r");

    const observedSettle = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      trigger: "settle",
      observeCompletion: {},
    });
    const observedTerminalId = observedSettle.status === "started" ? observedSettle.terminalId : "";
    assert.notEqual(observedTerminalId, settleTerminalId);
    assert.match(write.mock.calls.at(-1)?.[0].data ?? "", /^ \S/);
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

const runObservedSetup = Effect.fnUntraced(function* (command: string, stdin = "") {
  let submitted = "";
  let listener: Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0];
  const lines: string[] = [];
  const cwd = yield* HostProcess.WorkingDirectory;
  const env = yield* HostProcess.Environment;
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
          write: ({ data }) =>
            Effect.sync(() => {
              submitted = data;
            }),
          closeIdle: () => Effect.void,
        }),
        ServerSettings.layerTest(),
        NodeCrypto.layer,
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(HostProcess.Environment, { SHELL: "/bin/bash" }),
      ),
    ),
  );
  const result = yield* Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    return yield* runner.runForThread({
      threadId: "thread-setup",
      worktreePath: cwd,
      project: {
        id: ProjectId.make("project-setup"),
        workspaceRoot: cwd,
        scripts: [
          {
            id: "setup",
            name: "Setup",
            command,
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ],
      },
      observeCompletion: {
        onOutputLine: (line) =>
          Effect.sync(() => {
            lines.push(line);
          }),
      },
    });
  }).pipe(Effect.provide(layer));
  assert.equal(result.status, "started");
  if (result.status !== "started" || !result.completion) return yield* Effect.die("no completion");

  // Enter becomes a newline at the terminal boundary; transport assertions below
  // cover line-editor submissions and canonical TTY limits that bash -c bypasses.
  const child = yield* Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        "/bin/bash",
        ["--noprofile", "--norc", "-c", submitted.replaceAll("\r", "\n")],
        {
          cwd,
          env: { PATH: env.PATH },
          stdin: Stream.make(new TextEncoder().encode(stdin)),
        },
      ),
    );
    return yield* Effect.all(
      {
        stdout: handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        stderr: handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        exitCode: handle.exitCode,
      },
      { concurrency: "unbounded" },
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  const terminal = { threadId: "thread-setup", terminalId: result.terminalId };
  yield* listener!({ type: "output", ...terminal, data: `${submitted}\n` });
  yield* listener!({ type: "output", ...terminal, data: child.stdout + child.stderr });
  // Process completion releases the observer even when a broken wrapper emits no sentinel.
  yield* listener!({ type: "closed", ...terminal });
  const completion = yield* result.completion;
  return { submitted, lines, exitCode: completion.exitCode };
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("POSIX setup completion", () => {
  it.effect("submits one line while preserving multiline shell syntax and literal text", () =>
    Effect.gen(function* () {
      const result = yield* runObservedSetup(
        [
          "printf '%s\\n' \"it's ready\" 'literal \\n $(printf wrong) `printf wrong` café'",
          "cat <<'END'",
          "$literal \\path 雪",
          "END",
          "printf '%s\\n' done # trailing comment",
        ].join("\r\n"),
      );
      assert.equal(result.submitted.at(-1), "\r");
      assert.notMatch(result.submitted.slice(0, -1), /[\r\n]/);
      assert.deepEqual(result.lines, [
        "it's ready",
        "literal \\n $(printf wrong) `printf wrong` café",
        "$literal \\path 雪",
        "done",
      ]);
      assert.equal(result.exitCode, 0);
    }),
  );

  it.effect("completes long scripts without exceeding canonical terminal line limits", () =>
    Effect.gen(function* () {
      const expected = Array.from(
        { length: 120 },
        (_, index) => `line-${index}: café 雪 'quoted' \\path`,
      );
      const command = expected
        .map((line) => `printf '%s\\n' "${line.replaceAll("\\", "\\\\")}"`)
        .join("\n");
      const utf8 = new TextEncoder();
      assert.isAbove(utf8.encode(command).byteLength, 4_096);

      const result = yield* runObservedSetup(command);
      assert.deepEqual(result.lines, expected);
      assert.equal(result.exitCode, 0);
      assert.equal(result.submitted.at(-1), "\r");
      assert.notInclude(result.submitted, "\n");
      // The runner can write before the shell switches the terminal out of canonical mode.
      for (const line of result.submitted.slice(0, -1).split("\r")) {
        assert.isBelow(utf8.encode(line).byteLength, 1_024);
      }
    }),
  );

  it.effect("leaves stdin available to the script without consuming completion commands", () =>
    Effect.gen(function* () {
      const result = yield* runObservedSetup(
        "read -r value\nprintf '%s\\n' \"$value\"",
        "from stdin \\path\n",
      );
      assert.deepEqual(result.lines, ["from stdin \\path"]);
      assert.equal(result.exitCode, 0);
    }),
  );

  it.effect(
    "preserves a trailing backslash-newline even when losing it would still exit zero",
    () =>
      Effect.gen(function* () {
        const result = yield* runObservedSetup("printf '%s\\n' direct\\\n");
        assert.deepEqual(result.lines, ["direct"]);
        assert.equal(result.exitCode, 0);
      }),
  );

  it.effect.each([
    { name: "an explicit exit", command: "exit 7", exitCode: 7 },
    { name: "a syntax error", command: "if then", exitCode: 2 },
  ])("reports a nonzero completion for $name", ({ command, exitCode }) =>
    Effect.gen(function* () {
      const result = yield* runObservedSetup(command);
      assert.equal(result.exitCode, exitCode);
    }),
  );
});
