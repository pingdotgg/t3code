import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  checkPiProviderStatus,
  discoverPiWorkspaceCommands,
  MINIMUM_PI_VERSION,
} from "./PiProvider.ts";

const encoder = new TextEncoder();
const decodeRecordLine = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function processHandle(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}) {
  const bytes = (value: string | undefined) =>
    value === undefined || value.length === 0
      ? Stream.empty
      : Stream.succeed(encoder.encode(value));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_001),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: bytes(input.stdout),
    stderr: bytes(input.stderr),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function piProbeSpawner(version: string) {
  return ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    return Effect.succeed(
      args.includes("--version")
        ? processHandle({ stdout: `pi ${version}\n` })
        : processHandle({ stderr: "RPC startup failed", exitCode: 1 }),
    );
  });
}

/**
 * A `pi --mode rpc` that answers `get_commands` with `commands` and records
 * the directory each process was spawned in.
 */
function piCommandsSpawner(commands: ReadonlyArray<unknown>, spawnedIn: Array<string | undefined>) {
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (ChildProcess.isStandardCommand(command)) spawnedIn.push(command.options.cwd);
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      let buffer = "";
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_001),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            buffer += new TextDecoder().decode(chunk);
            let newline = buffer.indexOf("\n");
            while (newline !== -1) {
              const record = decodeRecordLine(buffer.slice(0, newline));
              buffer = buffer.slice(newline + 1);
              const response = { type: "response", id: record["id"], success: true };
              const data = record["type"] === "get_commands" ? { commands } : undefined;
              yield* Queue.offer(
                stdout,
                encoder.encode(`${encodeJsonLine({ ...response, data })}\n`),
              );
              newline = buffer.indexOf("\n");
            }
          }),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
}

const settings = {
  enabled: true,
  binaryPath: "pi",
  launchArgs: "",
  customModels: [],
} as const;

describe("PiProvider", () => {
  it.effect("requires the first published Pi version with entries and settlement hooks", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.80.3")),
      );
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.version, "0.80.3");
      assert.include(snapshot.message ?? "", `Pi ${MINIMUM_PI_VERSION} or newer`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps compatible Pi selectable when optional discovery fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.84.3")),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "unknown");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
      assert.include(snapshot.message ?? "", "could not refresh its models and commands");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("discovers a workspace's project skills from Pi running in that workspace", () =>
    Effect.gen(function* () {
      const spawnedIn: Array<string | undefined> = [];
      const discovered = yield* discoverPiWorkspaceCommands(settings, {}, "/workspace").pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          piCommandsSpawner(
            [
              {
                name: "skill:project-deploy",
                source: "skill",
                sourceInfo: { path: "/workspace/.pi/skills/project-deploy/SKILL.md" },
              },
            ],
            spawnedIn,
          ),
        ),
      );
      assert.deepEqual(spawnedIn, ["/workspace"]);
      assert.deepEqual(
        discovered.skills.map((skill) => skill.name),
        ["project-deploy"],
      );
      assert.deepEqual(
        discovered.slashCommands.map((command) => command.name),
        ["compact"],
      );
    }),
  );
});
