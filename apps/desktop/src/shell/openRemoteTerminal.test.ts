import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  cmdStartRemoteArgs,
  linuxRemoteTerminalArgs,
  openRemoteTerminal,
  windowsTerminalRemoteArgs,
} from "./openRemoteTerminal.ts";

const captureSpawner = (spawned: Array<{ command: string; args: ReadonlyArray<string> }>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command)) {
        spawned.push({
          command: command.command,
          args: command.args.map(String),
        });
      }
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

describe("openRemoteTerminal", () => {
  it.effect("opens Terminal.app via osascript with an ssh -t login shell", () =>
    Effect.gen(function* () {
      const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      const opened = yield* openRemoteTerminal({
        host: "sol",
        username: "theo",
        absolutePath: "/work/project",
      }).pipe(
        Effect.provide(Layer.merge(NodeServices.layer, captureSpawner(spawned))),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.Environment, {}),
      );
      assert.isTrue(opened);
      assert.equal(spawned.length, 1);
      assert.equal(spawned[0]?.command, "osascript");
      const script = spawned[0]?.args.join(" ") ?? "";
      assert.match(script, /tell application "Terminal" to do script/);
      // Each argv is shell-quoted: 'ssh' '-t' '--' 'theo@sol' 'exec /bin/sh -c ...'
      assert.match(script, /'ssh' '-t' '--' 'theo@sol'/);
      assert.match(script, /exec \/bin\/sh -c/);
      assert.match(script, /\/work\/project/);
      assert.match(script, /\$\{SHELL:-\/bin\/sh\}/);
    }),
  );

  it.effect("falls back to cmd start on Windows when Windows Terminal is missing", () =>
    Effect.gen(function* () {
      const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      const opened = yield* openRemoteTerminal({
        host: "box",
        absolutePath: "/home/theo/app/README.md",
        isFile: true,
      }).pipe(
        Effect.provide(Layer.merge(NodeServices.layer, captureSpawner(spawned))),
        Effect.provideService(HostProcess.Platform, "win32"),
        // Empty PATH so wt.exe is unavailable and the cmd.exe fallback runs.
        Effect.provideService(HostProcess.Environment, { PATH: "", Path: "", path: "" }),
      );
      assert.isTrue(opened);
      assert.equal(spawned[0]?.command, "cmd.exe");
      assert.deepEqual(spawned[0]?.args.slice(0, 3), ["/c", "start", ""]);
      assert.deepEqual(
        [...(spawned[0]?.args ?? [])].filter(
          (arg) => arg === "ssh.exe" || arg === "-t" || arg === "--" || arg === "box",
        ),
        ["ssh.exe", "-t", "--", "box"],
      );
      assert.isTrue(
        (spawned[0]?.args ?? []).some(
          (arg) => arg.includes("exec /bin/sh -c") && arg.includes("'/home/theo/app'"),
        ),
      );
    }),
  );

  it.effect("escapes percent sequences on the cmd fallback", () =>
    Effect.gen(function* () {
      const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      const opened = yield* openRemoteTerminal({
        host: "box",
        absolutePath: "/home/%USERPROFILE%/app",
      }).pipe(
        Effect.provide(Layer.merge(NodeServices.layer, captureSpawner(spawned))),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, { PATH: "", Path: "", path: "" }),
      );
      assert.isTrue(opened);
      assert.equal(spawned[0]?.command, "cmd.exe");
      const remoteArg = (spawned[0]?.args ?? []).find((arg) => arg.includes("USERPROFILE")) ?? "";
      assert.match(remoteArg, /%%USERPROFILE%%/);
    }),
  );
});

describe("linuxRemoteTerminalArgs", () => {
  it("runs SSH through xfce4-terminal -x", () => {
    assert.deepEqual(linuxRemoteTerminalArgs("xfce4-terminal", "ssh", ["-t", "--", "box", "cmd"]), [
      "-x",
      "ssh",
      "-t",
      "--",
      "box",
      "cmd",
    ]);
  });

  it("keeps gnome-terminal option terminator", () => {
    assert.deepEqual(linuxRemoteTerminalArgs("gnome-terminal", "ssh", ["-t", "--", "box"]), [
      "--",
      "ssh",
      "-t",
      "--",
      "box",
    ]);
  });
});

describe("Windows launch argv", () => {
  it("opens a new Windows Terminal window and escapes semicolon paths", () => {
    assert.deepEqual(
      windowsTerminalRemoteArgs("ssh.exe", [
        "-t",
        "--",
        "box",
        "exec /bin/sh -c 'cd -- \"$1\" && exec \"${SHELL:-/bin/sh}\" -l' sh '/home/theo/weird;dir'",
      ]),
      [
        "-w",
        "-1",
        "nt",
        "--",
        "ssh.exe",
        "-t",
        "--",
        "box",
        "exec /bin/sh -c 'cd -- \"$1\" && exec \"${SHELL:-/bin/sh}\" -l' sh '/home/theo/weird\\;dir'",
      ],
    );
  });

  it("doubles cmd percent signs in start argv", () => {
    assert.deepEqual(
      cmdStartRemoteArgs("ssh.exe", [
        "-t",
        "--",
        "box",
        "exec /bin/sh -c 'cd -- \"$1\" && exec \"${SHELL:-/bin/sh}\" -l' sh '/home/%USERPROFILE%/app'",
      ]),
      [
        "/c",
        "start",
        "",
        "ssh.exe",
        "-t",
        "--",
        "box",
        "exec /bin/sh -c 'cd -- \"$1\" && exec \"${SHELL:-/bin/sh}\" -l' sh '/home/%%USERPROFILE%%/app'",
      ],
    );
  });
});
