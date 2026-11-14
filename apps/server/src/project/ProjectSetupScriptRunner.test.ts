import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  TerminalNotRunningError,
  type TerminalEvent,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const threadId = "thread-1";
const terminalId = "setup-setup";
const event = { threadId, terminalId, sequence: 1, createdAt: "2026-01-01T00:00:00.000Z" };

const openSnapshot = (history: string): TerminalSessionSnapshot => ({
  threadId,
  terminalId,
  cwd: "/repo/.t3/worktrees/feature",
  worktreePath: null,
  status: "running",
  pid: 123,
  history,
  exitCode: null,
  exitSignal: null,
  label: "zsh",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const makeHarness = Effect.fn(function* (options: {
  readonly command?: string;
  readonly history?: string;
  readonly opening?: Deferred.Deferred<void>;
  readonly shell?: string | null;
  readonly observe?: boolean;
}) {
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const writes = yield* Queue.unbounded<string>();
  const outputLines = yield* Queue.unbounded<string>();
  const openedEnvs: Array<Record<string, string> | undefined> = [];
  const terminals = Layer.mock(TerminalManager.TerminalManager)({
    open: (input) =>
      Effect.sync(() => openedEnvs.push(input.env)).pipe(
        Effect.andThen(
          options.opening
            ? Deferred.succeed(options.opening, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
        ),
        Effect.as(openSnapshot(options.history ?? "")),
      ),
    getShell: () =>
      options.shell === null
        ? Effect.fail(new TerminalNotRunningError({ threadId, terminalId }))
        : Effect.succeed(options.shell ?? "/bin/zsh"),
    subscribe: (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    write: (input) => Queue.offer(writes, input.data).pipe(Effect.asVoid),
    closeIdle: () => Effect.void,
    closeOnSettle: () => Effect.void,
  });
  const runner = yield* ProjectSetupScriptRunner.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        terminals,
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () => Effect.succeed(null),
        }),
        ServerSettings.layerTest(),
        NodeCrypto.layer,
      ),
    ),
  );
  const start = runner.runForThread({
    threadId,
    worktreePath: "/repo/.t3/worktrees/feature",
    ...(options.observe === false
      ? {}
      : { observeCompletion: { onOutputLine: (line) => Queue.offer(outputLines, line) } }),
    project: {
      id: ProjectId.make("project-1"),
      workspaceRoot: "/repo",
      scripts: [
        {
          id: "setup",
          name: "Setup",
          command: options.command ?? "vp i",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ],
    },
  });
  const emit = (terminalEvent: TerminalEvent) =>
    Effect.forEach([...listeners], (listener) => listener(terminalEvent), { discard: true });
  return { start, listeners, writes, outputLines, openedEnvs, emit };
});

const setup = Effect.fn(function* (
  options: {
    readonly command?: string;
    readonly history?: string;
    readonly shell?: string | null;
  } = {},
) {
  const harness = yield* makeHarness(options);
  const result = yield* harness.start;
  const completion = result.status === "started" ? result.completion : undefined;
  if (!completion) return yield* Effect.die("setup did not start an observed run");
  return { ...harness, result, completion };
});

describe("ProjectSetupScriptRunner", () => {
  it.effect("writes immediately when the spawned fallback is PowerShell", () =>
    Effect.gen(function* () {
      const { writes } = yield* setup({
        shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      });
      expect(yield* Queue.take(writes)).toContain("$global:LASTEXITCODE");
    }),
  );

  it.effect("types an escaped Nushell wrapper once its line editor starts", () =>
    Effect.gen(function* () {
      const command =
        'print "quoted"; print \'C:\\tools\'; print "$env.PATH"\nexit 7 # comment\r\n\t';
      const escaped =
        'print \\"quoted\\"; print \'C:\\\\tools\'; print \\"$env.PATH\\"\\u{a}exit 7 # comment\\u{d}\\u{a}\\u{9}';
      const { writes, emit } = yield* setup({ shell: "/opt/homebrew/bin/nu", command });
      yield* TestClock.adjust("1 second");
      expect(yield* Queue.size(writes)).toBe(0);
      yield* emit({ ...event, type: "output", data: "> \x1b[?2004h" });
      const written = yield* Queue.take(writes);
      const sentinel = written.match(/__T3_SETUP_DONE___[0-9a-f]{32}:/)?.[0];
      expect(sentinel).toBeDefined();
      expect(written).toBe(
        ` ${[
          "$env.LAST_EXIT_CODE = 0",
          "let __t3f = try { mktemp --tmpdir-path $env.T3CODE_WORKTREE_PATH --suffix .nu .t3-setup-XXXXXXXX } catch {|e| print -e $e.msg; null }",
          `if $__t3f == null { $env.LAST_EXIT_CODE = 1 } else { try { [$"rm --permanent ($__t3f | to nuon)" "${escaped}"] | str join (char newline) | save --force --raw $__t3f; ^$nu.current-exe --login --commands $"$env.NO_COLOR = '1'; $env.FORCE_COLOR = '0'; $env.COLORTERM = ''; cd $env.T3CODE_WORKTREE_PATH; source ($__t3f | to nuon)" } catch {|e| if $e != null and $e.exit_code? == null { print -e $e.msg }; if $env.LAST_EXIT_CODE == 0 { $env.LAST_EXIT_CODE = 1 } } }`,
          "let __t3c = $env.LAST_EXIT_CODE",
          "try { if $__t3f != null and ($__t3f | path exists) { rm --permanent $__t3f } } catch {|e| print -e $e.msg }",
          `print $"\\n${sentinel}($__t3c)"`,
        ].join("; ")}\r`,
      );
    }),
  );

  it.effect.each([
    { shell: "/bin/zsh", scoped: "( export NO_COLOR=1 FORCE_COLOR=0 COLORTERM=; " },
    {
      shell: "/opt/homebrew/bin/fish",
      scoped: "begin\rset -lx NO_COLOR 1; set -lx FORCE_COLOR 0; set -lx COLORTERM ''\rvp i\rend",
    },
    { shell: "/opt/homebrew/bin/nu", scoped: "$env.NO_COLOR = '1'; $env.FORCE_COLOR = '0'" },
    {
      shell: "pwsh",
      scoped: "$env:NO_COLOR = '1'; $env:FORCE_COLOR = '0'; $env:COLORTERM = $null;",
    },
  ])("disables color for the script but not the shell it leaves ($shell)", ({ shell, scoped }) =>
    Effect.gen(function* () {
      const { writes, openedEnvs, emit } = yield* setup({ shell });
      yield* emit({ ...event, type: "output", data: "\x1b[?2004h" });
      expect(yield* Queue.take(writes)).toContain(scoped);
      expect(openedEnvs).toHaveLength(1);
      expect(openedEnvs[0]).not.toHaveProperty("NO_COLOR");
      expect(openedEnvs[0]).not.toHaveProperty("FORCE_COLOR");
      expect(openedEnvs[0]).not.toHaveProperty("COLORTERM");
    }),
  );

  it.effect.each([
    { shell: "/bin/zsh", written: /^ \( export NO_COLOR=1 [^\r]*eval [^\r]* \)\r$/ },
    { shell: "/usr/bin/xonsh", written: /^ vp i\r$/ },
  ])("types an unobserved script without a sentinel ($shell)", ({ shell, written }) =>
    Effect.gen(function* () {
      const { start, writes } = yield* makeHarness({ shell, observe: false });
      yield* start;
      yield* TestClock.adjust("3 seconds");
      expect(yield* Queue.take(writes)).toMatch(written);
    }),
  );

  it.effect("shows a startup prompt and types only once the line editor starts", () =>
    Effect.gen(function* () {
      const { result, writes, outputLines, emit } = yield* setup();
      expect(result).toMatchObject({ status: "started", terminalId });

      yield* emit({ ...event, type: "output", data: "Missing Node.\r\nInstall it? [y/N]: " });
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
      expect(yield* Queue.takeAll(outputLines)).toEqual(["Missing Node.", "Install it? [y/N]:"]);

      yield* emit({ ...event, type: "activity", hasRunningSubprocess: false, label: "zsh" });
      yield* emit({ ...event, type: "output", data: "\r\n% \x1b[?2004h" });
      expect(yield* Queue.take(writes)).toContain("vp i");
    }),
  );

  it.effect("types into a quiet shell that has no line editor", () =>
    Effect.gen(function* () {
      const { writes } = yield* setup();
      yield* TestClock.adjust("3 seconds");
      expect(yield* Queue.take(writes)).toContain("vp i");
    }),
  );

  it.effect("ignores line editor state restored from an earlier shell", () =>
    Effect.gen(function* () {
      const { writes, emit } = yield* setup({ history: "old run\r\n% \x1b[?2004h" });
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
    }),
  );

  it.effect("forgets a busy startup child when the shell restarts", () =>
    Effect.gen(function* () {
      const { writes, emit } = yield* setup();
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
      yield* emit({ ...event, type: "restarted", snapshot: openSnapshot("") });
      // The restart lands inside a quiet window, so the next full window decides.
      yield* TestClock.adjust("6 seconds");
      expect(yield* Queue.take(writes)).toContain("vp i");
    }),
  );

  it.effect("drops its terminal listeners when cancelled while the terminal opens", () =>
    Effect.gen(function* () {
      const opening = yield* Deferred.make<void>();
      const { start, listeners } = yield* makeHarness({ opening });
      const fiber = yield* Effect.forkChild(start);
      yield* Deferred.await(opening);
      expect(listeners.size).toBe(2);
      yield* Fiber.interrupt(fiber);
      expect(listeners.size).toBe(0);
    }),
  );

  it.effect.each([false, true])(
    "does not type into a shell that exits during startup (before shell lookup: %s)",
    (beforeShellLookup) =>
      Effect.gen(function* () {
        const { completion, writes, emit, listeners } = yield* setup(
          beforeShellLookup ? { shell: null } : {},
        );
        if (!beforeShellLookup) {
          yield* emit({ ...event, type: "exited", exitCode: 1, exitSignal: null });
        }
        expect(yield* completion).toMatchObject({ exitCode: null });
        yield* TestClock.adjust("1 minute");
        expect(yield* Queue.size(writes)).toBe(0);
        expect(listeners.size).toBe(0);
      }),
  );
});

const runObservedSetup = Effect.fnUntraced(function* (command: string, after = "") {
  const { writes, outputLines, emit, completion } = yield* setup({ command });
  yield* emit({ ...event, type: "output", data: "\x1b[?2004h" });
  const submitted = yield* Queue.take(writes);
  const cwd = yield* HostProcess.WorkingDirectory;
  const env = yield* HostProcess.Environment;

  // Enter becomes a newline at the terminal boundary; transport assertions below
  // cover line-editor submissions and canonical TTY limits that bash -c bypasses.
  const child = yield* Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        "/bin/bash",
        ["--noprofile", "--norc", "-c", (submitted + after).replaceAll("\r", "\n")],
        {
          cwd,
          env: { PATH: env.PATH },
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
  yield* emit({ ...event, type: "output", data: submitted + "\n" });
  yield* emit({ ...event, type: "output", data: child.stdout + child.stderr });
  yield* emit({ ...event, type: "closed" });
  return {
    submitted,
    lines: yield* Queue.clear(outputLines),
    exitCode: (yield* completion).exitCode,
  };
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("POSIX setup completion", () => {
  it.live("submits one line while preserving multiline shell syntax and literal text", () =>
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

  it.live("completes long scripts without exceeding canonical terminal line limits", () =>
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

  it.live("preserves a trailing backslash-newline even when losing it would still exit zero", () =>
    Effect.gen(function* () {
      const result = yield* runObservedSetup("printf '%s\\n' direct\\\n");
      assert.deepEqual(result.lines, ["direct"]);
      assert.equal(result.exitCode, 0);
    }),
  );

  it.live("scopes the color opt-outs to the script", () =>
    Effect.gen(function* () {
      const probe = `printf '%s|%s|%s\\n' "\${NO_COLOR-unset}" "\${FORCE_COLOR-unset}" "\${COLORTERM-unset}"`;
      const result = yield* runObservedSetup(probe, `\r${probe}`);
      assert.deepEqual(result.lines, ["1|0|", "unset|unset|unset"]);
    }),
  );

  it.live.each([
    { name: "an explicit exit", command: "exit 7", exitCode: 7 },
    { name: "a syntax error", command: "if then", exitCode: 2 },
  ])("reports a nonzero completion for $name", ({ command, exitCode }) =>
    Effect.gen(function* () {
      const result = yield* runObservedSetup(command);
      assert.equal(result.exitCode, exitCode);
    }),
  );
});
