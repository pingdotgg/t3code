import { Buffer } from "node:buffer";

import { Effect, Layer, Option, PlatformError, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectPosixProcessFamilyPids, checkPosixListeningPorts } from "../posix.ts";
import type {
  TerminalProcessInspectorShape,
  TerminalSubprocessActivity,
} from "../Services/TerminalProcessInspector.ts";
import {
  TerminalProcessInspector,
  TerminalProcessInspectionError,
} from "../Services/TerminalProcessInspector.ts";
import { checkWindowsListeningPorts, collectWindowsChildPids } from "../win32.ts";

const DEFAULT_COMMAND_KILL_GRACE_MS = 1_000;

interface InspectorCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface CollectOutputResult {
  readonly text: string;
  readonly truncated: boolean;
}

interface RunInspectorCommandInput {
  readonly operation: string;
  readonly terminalPid: number;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

function commandLabel(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].join(" ");
}

const collectOutput = Effect.fn("process.collectOutput")(function* (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  maxOutputBytes: number,
): Effect.fn.Return<CollectOutputResult, PlatformError.PlatformError> {
  return yield* stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => ({
        text: "",
        bytes: 0,
        truncated: false,
      }),
      (state, chunk) => {
        if (state.bytes >= maxOutputBytes) {
          return {
            ...state,
            truncated: true,
          };
        }

        const chunkBytes = Buffer.byteLength(chunk);
        const remainingBytes = maxOutputBytes - state.bytes;
        if (chunkBytes <= remainingBytes) {
          return {
            text: `${state.text}${chunk}`,
            bytes: state.bytes + chunkBytes,
            truncated: state.truncated,
          };
        }

        const truncatedChunk = Buffer.from(chunk).subarray(0, remainingBytes).toString("utf8");
        return {
          text: `${state.text}${truncatedChunk}`,
          bytes: state.bytes + remainingBytes,
          truncated: true,
        };
      },
    ),
    Effect.map(({ text, truncated }) => ({ text, truncated })),
  );
});

const makeTerminalProcessInspector = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runInspectorCommand = Effect.fn("process.runInspectorCommand")(function* (
    input: RunInspectorCommandInput,
  ) {
    const command = ChildProcess.make(input.command, [...input.args], {
      killSignal: "SIGTERM",
      forceKillAfter: DEFAULT_COMMAND_KILL_GRACE_MS,
    });

    return yield* Effect.gen(function* () {
      const child = yield* spawner.spawn(command).pipe(
        Effect.mapError(
          (cause) =>
            new TerminalProcessInspectionError({
              operation: input.operation,
              terminalPid: input.terminalPid,
              command: commandLabel(input.command, input.args),
              detail: "Failed to spawn inspector command.",
              cause,
            }),
        ),
      );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectOutput(child.stdout, input.maxOutputBytes).pipe(
            Effect.mapError(
              (cause) =>
                new TerminalProcessInspectionError({
                  operation: input.operation,
                  terminalPid: input.terminalPid,
                  command: commandLabel(input.command, input.args),
                  detail: "Failed to read stdout from inspector command.",
                  cause,
                }),
            ),
          ),
          collectOutput(child.stderr, input.maxOutputBytes).pipe(
            Effect.mapError(
              (cause) =>
                new TerminalProcessInspectionError({
                  operation: input.operation,
                  terminalPid: input.terminalPid,
                  command: commandLabel(input.command, input.args),
                  detail: "Failed to read stderr from inspector command.",
                  cause,
                }),
            ),
          ),
          child.exitCode.pipe(
            Effect.map(Number),
            Effect.mapError(
              (cause) =>
                new TerminalProcessInspectionError({
                  operation: input.operation,
                  terminalPid: input.terminalPid,
                  command: commandLabel(input.command, input.args),
                  detail: "Failed to read inspector command exit code.",
                  cause,
                }),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      return {
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode,
      } satisfies InspectorCommandResult;
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(input.timeoutMs),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TerminalProcessInspectionError({
                operation: input.operation,
                terminalPid: input.terminalPid,
                command: commandLabel(input.command, input.args),
                detail: "Inspector command timed out.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  });

  const inspect: TerminalProcessInspectorShape["inspect"] = Effect.fn("process.inspect")(function* (
    terminalPid: number,
  ) {
    if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
      return {
        hasRunningSubprocess: false,
        runningPorts: [],
      } satisfies TerminalSubprocessActivity;
    }

    if (process.platform === "win32") {
      const childPids = yield* collectWindowsChildPids(terminalPid, runInspectorCommand);
      const processPidsForPortScan = [terminalPid, ...childPids];
      const runningPorts = yield* checkWindowsListeningPorts(processPidsForPortScan, {
        terminalPid,
        runCommand: runInspectorCommand,
      });
      return {
        hasRunningSubprocess: childPids.length > 0 || runningPorts.length > 0,
        runningPorts,
      } satisfies TerminalSubprocessActivity;
    }

    const processFamilyPids = yield* collectPosixProcessFamilyPids(
      terminalPid,
      runInspectorCommand,
    );
    if (processFamilyPids.length === 0) {
      return {
        hasRunningSubprocess: false,
        runningPorts: [],
      } satisfies TerminalSubprocessActivity;
    }

    const subprocessPids = processFamilyPids.filter((pid: number) => pid !== terminalPid);
    const runningPorts = yield* checkPosixListeningPorts(processFamilyPids, {
      terminalPid,
      runCommand: runInspectorCommand,
      platform: process.platform,
    });
    return {
      hasRunningSubprocess: subprocessPids.length > 0 || runningPorts.length > 0,
      runningPorts,
    } satisfies TerminalSubprocessActivity;
  });

  return {
    inspect,
  } satisfies TerminalProcessInspectorShape;
});

export const TerminalProcessInspectorLive = Layer.effect(
  TerminalProcessInspector,
  makeTerminalProcessInspector,
);
