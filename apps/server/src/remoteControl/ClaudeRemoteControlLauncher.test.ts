import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertSuccess } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildRemoteControlArgs,
  buildRemoteControlInteractiveCommandLine,
  launchClaudeRemoteControl,
  resolveRemoteControlLaunch,
} from "./ClaudeRemoteControlLauncher.ts";

function makeMockHandle(exitCode: number) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.sync(() => Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

it("buildRemoteControlArgs builds the server-mode argv", () => {
  assert.deepEqual(buildRemoteControlArgs({ mode: "server" }), ["remote-control"]);
});

it("buildRemoteControlArgs builds the interactive-mode argv", () => {
  assert.deepEqual(buildRemoteControlArgs({ mode: "interactive" }), ["--remote-control"]);
});

it("buildRemoteControlArgs inserts --name before passthrough", () => {
  assert.deepEqual(
    buildRemoteControlArgs({
      mode: "server",
      name: "work session",
      passthrough: ["--foo", "bar"],
    }),
    ["remote-control", "--name", "work session", "--foo", "bar"],
  );
  assert.deepEqual(
    buildRemoteControlArgs({
      mode: "interactive",
      name: "  ",
      passthrough: ["--chrome"],
    }),
    ["--remote-control", "--chrome"],
  );
});

it("buildRemoteControlInteractiveCommandLine forces interactive mode", () => {
  const line = buildRemoteControlInteractiveCommandLine(
    { binaryPath: "claude", homePath: "" },
    { name: "desktop" },
  );
  assert.equal(line.command, "claude");
  assert.deepEqual(line.args, ["--remote-control", "--name", "desktop"]);
});

it.layer(NodeServices.layer)("resolveRemoteControlLaunch", (it) => {
  it.effect("resolves binary, mode flag, and inherited stdio", () =>
    Effect.gen(function* () {
      const launch = yield* resolveRemoteControlLaunch(
        { binaryPath: "claude", homePath: "" },
        { mode: "server", baseEnv: { PATH: "/usr/bin" } },
      );
      assert.equal(launch.command, "claude");
      assert.deepEqual(launch.args, ["remote-control"]);
      assert.equal(launch.options.extendEnv, true);
      assert.equal(launch.options.stdin, "inherit");
      assert.equal(launch.options.stdout, "inherit");
      assert.equal(launch.options.stderr, "inherit");
      // Empty homePath leaves the base env untouched (no HOME override).
      assert.deepEqual(launch.options.env, { PATH: "/usr/bin" });
      assert.equal("cwd" in launch.options, false);
    }),
  );

  it.effect("derives HOME from homePath via makeClaudeEnvironment and honors cwd", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const launch = yield* resolveRemoteControlLaunch(
        { binaryPath: "/opt/claude", homePath: "/tmp/claude-home-personal" },
        {
          mode: "interactive",
          name: "personal",
          passthrough: ["--verbose"],
          cwd: "/tmp/workspace",
          baseEnv: { PATH: "/usr/bin" },
        },
      );
      assert.equal(launch.command, "/opt/claude");
      assert.deepEqual(launch.args, ["--remote-control", "--name", "personal", "--verbose"]);
      assert.equal(launch.options.cwd, "/tmp/workspace");
      // HOME is set to the resolved (absolute) homePath; PATH is preserved.
      assert.equal(launch.options.env?.HOME, path.resolve("/tmp/claude-home-personal"));
      assert.equal(launch.options.env?.PATH, "/usr/bin");
    }),
  );
});

it.layer(NodeServices.layer)("launchClaudeRemoteControl", (it) => {
  it.effect("spawns the claude binary with the resolved RC command", () =>
    Effect.gen(function* () {
      let spawnedCommand: ChildProcess.StandardCommand | undefined;
      const spawnerLayer = Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
        spawn: (command) =>
          Effect.sync(() => {
            assert.equal(ChildProcess.isStandardCommand(command), true);
            if (!ChildProcess.isStandardCommand(command)) {
              throw new Error("Expected a standard command");
            }
            spawnedCommand = command;
            return makeMockHandle(0);
          }),
      });

      const result = yield* launchClaudeRemoteControl(
        { binaryPath: "claude", homePath: "" },
        { mode: "server", name: "work", baseEnv: { PATH: "/usr/bin" } },
      ).pipe(Effect.provide(spawnerLayer), Effect.result);

      assertSuccess(result, 0);
      assert.ok(spawnedCommand);
      assert.equal(spawnedCommand.command, "claude");
      assert.deepEqual(spawnedCommand.args, ["remote-control", "--name", "work"]);
      assert.equal(spawnedCommand.options.stdout, "inherit");
    }),
  );

  it.effect("fails with ClaudeRemoteControlExitError on non-zero exit", () =>
    Effect.gen(function* () {
      const spawnerLayer = Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
        spawn: () => Effect.sync(() => makeMockHandle(2)),
      });

      const result = yield* launchClaudeRemoteControl(
        { binaryPath: "claude", homePath: "" },
        { mode: "interactive" },
      ).pipe(Effect.provide(spawnerLayer), Effect.result);

      assert.equal(result._tag, "Failure");
    }),
  );
});
