import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { buildRemoteSshTerminalRemoteCommand } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  linuxRemoteTerminalArgs,
  openRemoteTerminal,
  powerShellStartRemoteArgs,
  serializeWindowsSshArgumentList,
  windowsTerminalRemoteArgs,
} from "./openRemoteTerminal.ts";

const decodePowerShellEncodedCommand = (encoded: string): string => {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder("utf-16le").decode(bytes);
};

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

  it.effect("falls back to PowerShell Start-Process when Windows Terminal is missing", () =>
    Effect.gen(function* () {
      const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      const opened = yield* openRemoteTerminal({
        host: "box",
        absolutePath: "/home/theo/app/README.md",
        isFile: true,
      }).pipe(
        Effect.provide(Layer.merge(NodeServices.layer, captureSpawner(spawned))),
        Effect.provideService(HostProcess.Platform, "win32"),
        // Empty PATH so wt.exe is unavailable and the PowerShell fallback runs.
        Effect.provideService(HostProcess.Environment, {
          PATH: "",
          Path: "",
          path: "",
          SYSTEMROOT: String.raw`C:\Windows`,
        }),
      );
      assert.isTrue(opened);
      assert.equal(
        spawned[0]?.command,
        String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
      );
      assert.deepEqual(spawned[0]?.args.slice(0, 5), [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
      ]);
      const script = decodePowerShellEncodedCommand(spawned[0]?.args[5] ?? "");
      assert.match(script, /Start-Process -FilePath 'ssh\.exe'/);
      assert.match(script, /ArgumentList '-t -- box "/);
      assert.match(script, /exec \/bin\/sh -c/);
      assert.match(script, /\/home\/theo\/app/);
    }),
  );

  it.effect("keeps ampersand destinations inside the Windows ArgumentList string", () =>
    Effect.gen(function* () {
      const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      const opened = yield* openRemoteTerminal({
        host: "box&calc&rem",
        absolutePath: "/home/%USERPROFILE%/app",
      }).pipe(
        Effect.provide(Layer.merge(NodeServices.layer, captureSpawner(spawned))),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, {
          PATH: "",
          Path: "",
          path: "",
          SYSTEMROOT: String.raw`C:\Windows`,
        }),
      );
      assert.isTrue(opened);
      const script = decodePowerShellEncodedCommand(spawned[0]?.args[5] ?? "");
      assert.match(script, /ArgumentList '-t -- box&calc&rem "/);
      assert.match(script, /%USERPROFILE%/);
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

  it("quotes spaces, quotes, and backslashes for Start-Process ArgumentList", () => {
    const remoteCommand = buildRemoteSshTerminalRemoteCommand(String.raw`/work/my "proj"\path`);
    const serialized = serializeWindowsSshArgumentList(["-t", "--", "box", remoteCommand]);
    assert.equal(
      serialized,
      `-t -- box "exec /bin/sh -c 'cd -- \\"$1\\" && exec \\"\${SHELL:-/bin/sh}\\" -l' sh '/work/my \\"proj\\"\\path'"`,
    );

    const args = powerShellStartRemoteArgs("ssh.exe", ["-t", "--", "box&calc&rem", remoteCommand]);
    const script = decodePowerShellEncodedCommand(args[5] ?? "");
    assert.match(script, /Start-Process -FilePath 'ssh\.exe'/);
    assert.match(script, /ArgumentList '-t -- box&calc&rem "/);
    assert.match(script, /my \\"proj\\"\\path/);
  });

  it("keeps smart single quotes inside PowerShell string literals", () => {
    const host = "box\u2019 ; Start-Process calc; #";
    const args = powerShellStartRemoteArgs("ssh.exe", ["-t", "--", host, "remote"]);
    const script = decodePowerShellEncodedCommand(args[5] ?? "");
    assert.match(script, /Start-Process -FilePath 'ssh\.exe'/);
    // Typographic ’ is doubled so it cannot close the ArgumentList literal.
    assert.match(script, /ArgumentList '-t -- "box\u2019\u2019 ; Start-Process calc; #" remote'/);
    assert.isFalse(script.includes(`box\u2019 ; Start-Process`));
  });
});
