import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessDiagnostics from "./ProcessDiagnostics.ts";

const encoder = new TextEncoder();

function mockHandle(result: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("ProcessDiagnostics", () => {
  it.effect("parses POSIX ps rows with full commands", () =>
    Effect.sync(() => {
      const rows = ProcessDiagnostics.parsePosixProcessRows(
        [
          "  10     1    10 Ss      0.0   1024   01:02.03 /usr/bin/node server.js",
          "  11    10    10 S+     12.5  20480      00:04 codex app-server --config /tmp/one two",
        ].join("\n"),
      );

      expect(rows).toEqual([
        {
          pid: 10,
          ppid: 1,
          pgid: 10,
          status: "Ss",
          cpuPercent: 0,
          rssBytes: 1024 * 1024,
          elapsed: "01:02.03",
          command: "/usr/bin/node server.js",
        },
        {
          pid: 11,
          ppid: 10,
          pgid: 10,
          status: "S+",
          cpuPercent: 12.5,
          rssBytes: 20480 * 1024,
          elapsed: "00:04",
          command: "codex app-server --config /tmp/one two",
        },
      ]);
    }),
  );

  it.effect("aggregates only descendants of the server process", () =>
    Effect.sync(() => {
      const diagnostics = ProcessDiagnostics.aggregateProcessDiagnostics({
        serverPid: 100,
        readAt: DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
        rows: [
          {
            pid: 100,
            ppid: 1,
            pgid: 100,
            status: "S",
            cpuPercent: 0,
            rssBytes: 1_000,
            elapsed: "01:00",
            command: "t3 server",
          },
          {
            pid: 101,
            ppid: 100,
            pgid: 100,
            status: "S",
            cpuPercent: 1.5,
            rssBytes: 2_000,
            elapsed: "00:20",
            command: "codex app-server",
          },
          {
            pid: 102,
            ppid: 101,
            pgid: 100,
            status: "R",
            cpuPercent: 3.25,
            rssBytes: 4_000,
            elapsed: "00:05",
            command: "git status",
          },
          {
            pid: 200,
            ppid: 1,
            pgid: 200,
            status: "S",
            cpuPercent: 99,
            rssBytes: 8_000,
            elapsed: "00:01",
            command: "unrelated",
          },
          {
            pid: 201,
            ppid: 100,
            pgid: 100,
            status: "R",
            cpuPercent: 9,
            rssBytes: 9_000,
            elapsed: "00:00",
            command: "ps -axo pid=,ppid=,pgid=,stat=,pcpu=,rss=,etime=,command=",
          },
        ],
      });

      expect(diagnostics.serverPid).toBe(100);
      expect(DateTime.formatIso(diagnostics.readAt)).toBe("2026-05-05T10:00:00.000Z");
      expect(diagnostics.processCount).toBe(2);
      expect(diagnostics.totalRssBytes).toBe(6_000);
      expect(diagnostics.totalCpuPercent).toBe(4.75);
      expect(diagnostics.processes.map((process) => process.pid)).toEqual([101, 102]);
      expect(diagnostics.processes.map((process) => process.depth)).toEqual([0, 1]);
      expect(Option.getOrNull(diagnostics.processes[0]!.pgid)).toBe(100);
      expect(diagnostics.processes[0]?.childPids).toEqual([102]);
    }),
  );

  it.effect("preserves ascending sibling order for nested descendants", () =>
    Effect.sync(() => {
      const diagnostics = ProcessDiagnostics.aggregateProcessDiagnostics({
        serverPid: 100,
        readAt: DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
        rows: [
          {
            pid: 101,
            ppid: 100,
            pgid: 100,
            status: "S",
            cpuPercent: 0,
            rssBytes: 100,
            elapsed: "00:10",
            command: "agent",
          },
          {
            pid: 103,
            ppid: 101,
            pgid: 100,
            status: "S",
            cpuPercent: 0,
            rssBytes: 100,
            elapsed: "00:10",
            command: "child-b",
          },
          {
            pid: 102,
            ppid: 101,
            pgid: 100,
            status: "S",
            cpuPercent: 0,
            rssBytes: 100,
            elapsed: "00:10",
            command: "child-a",
          },
        ],
      });

      expect(diagnostics.processes.map((process) => process.pid)).toEqual([101, 102, 103]);
    }),
  );

  it.effect("queries processes through the ChildProcessSpawner service", () =>
    Effect.gen(function* () {
      const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
        [];
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          const childProcess = command as unknown as {
            readonly command: string;
            readonly args: ReadonlyArray<string>;
          };
          commands.push({ command: childProcess.command, args: childProcess.args });
          return Effect.succeed(
            mockHandle({
              stdout: [
                ` ${process.pid}     1 ${process.pid} Ss 0.0 1024 01:02.03 t3 server`,
                ` 4242 ${process.pid} ${process.pid} S  1.5 2048 00:04 agent`,
              ].join("\n"),
            }),
          );
        }),
      );
      const layer = ProcessDiagnostics.layer.pipe(Layer.provide(spawnerLayer));

      const diagnostics = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((pd) => pd.read),
        Effect.provide(layer),
      );

      expect(diagnostics.processes.map((process) => process.pid)).toEqual([4242]);
      expect(commands).toEqual([
        {
          command: "ps",
          args: ["-axo", "pid=,ppid=,pgid=,stat=,pcpu=,rss=,etime=,command="],
        },
      ]);
    }),
  );

  it.effect("does not allow signaling the diagnostics query process", () =>
    Effect.gen(function* () {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            mockHandle({
              stdout: [
                ` ${process.pid}     1 ${process.pid} Ss 0.0 1024 01:02.03 t3 server`,
                ` 4242 ${process.pid} ${process.pid} R  1.5 2048 00:00 ps -axo pid=,ppid=,pgid=,stat=,pcpu=,rss=,etime=,command=`,
              ].join("\n"),
            }),
          ),
        ),
      );
      const layer = ProcessDiagnostics.layer.pipe(Layer.provide(spawnerLayer));

      const result = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((pd) => pd.signal({ pid: 4242, signal: "SIGINT" })),
        Effect.provide(layer),
      );

      expect(result).toEqual({
        pid: 4242,
        signal: "SIGINT",
        signaled: false,
        message: Option.some("Process 4242 is not a live descendant of the T3 server."),
      });
    }),
  );
});
