import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { SshCommandError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  buildPowerShellEncodedCommandArgs,
  buildWindowsRemoteLaunchScript,
  buildWindowsRemoteLogTailScript,
  buildWindowsRemotePairingScript,
  buildWindowsRemoteStopScript,
  isWindowsRemoteShellError,
  psSingleQuote,
  WINDOWS_CONTROL_MASTER_KEEPALIVE_ARGS,
} from "./windowsRemote.ts";

const makeProcess = (stdout: string, stderr = "", exitCode = 0) => {
  const stdoutStream = stdout ? Stream.make(new TextEncoder().encode(stdout)) : Stream.empty;
  const stderrStream = stderr ? Stream.make(new TextEncoder().encode(stderr)) : Stream.empty;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(42),
    stdout: stdoutStream,
    stderr: stderrStream,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args.map(String) : [];
}

describe("windowsRemote helpers", () => {
  it("quotes PowerShell single-quoted literals safely", () => {
    assert.strictEqual(psSingleQuote("plain"), "'plain'");
    assert.strictEqual(psSingleQuote("it's $HOME"), "'it''s $HOME'");
  });

  it("encodes PowerShell commands as UTF-16LE base64", () => {
    const args = buildPowerShellEncodedCommandArgs("Write-Output 'ok'");
    assert.deepStrictEqual(args.slice(0, -1), [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
    ]);
    const decoded = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
    assert.strictEqual(decoded, "Write-Output 'ok'");
  });

  it("detects Windows OpenSSH cmd.exe and PowerShell error messages", () => {
    const cases = [
      "'sh' is not recognized as an internal or external command,\r\noperable program or batch file.",
      "'zsh' is not recognized as an internal or external command,",
      "'sh' 不是内部或外部命令，也不是可运行的程序",
      "sh : The term 'sh' is not recognized as the name of a cmdlet",
      "CommandNotFoundException",
    ];
    for (const stderr of cases) {
      assert.isTrue(
        isWindowsRemoteShellError(
          new SshCommandError({
            command: ["ssh", "win-home", "sh"],
            exitCode: 1,
            stderr,
            message: stderr,
          }),
        ),
        `Expected to match: ${stderr}`,
      );
    }

    assert.isFalse(
      isWindowsRemoteShellError(
        new SshCommandError({
          command: ["ssh", "linux-host", "sh"],
          exitCode: 255,
          stderr: "Permission denied (publickey).",
          message: "Permission denied (publickey).",
        }),
      ),
    );
  });

  it("builds Windows launch, pairing, stop, and log-tail scripts", () => {
    const launch = buildWindowsRemoteLaunchScript({
      stateKey: "abc123",
      launcherId: "0123456789abcdef0123456789abcdef",
      runner: { archiveVersion: "0.1.12-nightly.20261125.5230" },
      defaultRemotePort: 3773,
      remotePortScanWindow: 200,
      readyTimeoutMs: 60_000,
      reuseReadyTimeoutMs: 2_000,
      readyProbeTimeoutMs: 1_000,
      archiveChecksumsSeconds: 30,
      archiveDownloadSeconds: 240,
      archiveLockWaitSeconds: 360,
      launchLockWaitSeconds: 600,
      updateMarkerFile: "update-in-progress.json",
      updateTtlMs: 30_000,
      runtimeRecordWaitSeconds: 10,
    });
    assert.include(launch, "win32-x64");
    assert.include(launch, "win32-arm64");
    assert.include(launch, "__ssh-helper");
    assert.include(launch, "System32\\tar.exe");

    const pairing = buildWindowsRemotePairingScript({
      stateKey: "abc123",
      runner: { archiveVersion: "0.1.12-nightly.20261125.5230" },
      archiveChecksumsSeconds: 30,
      archiveDownloadSeconds: 240,
      archiveLockWaitSeconds: 360,
    });
    assert.include(pairing, "pairing");

    const stop = buildWindowsRemoteStopScript({ stateKey: "abc123", launcherId: null });
    assert.include(stop, "Stop-Process");

    const logTail = buildWindowsRemoteLogTailScript("abc123");
    assert.include(logTail, "server.log");
    assert.isTrue(WINDOWS_CONTROL_MASTER_KEEPALIVE_ARGS.includes("-EncodedCommand"));
  });

  it("includes MINGW/MSYS/CYGWIN zip support in the POSIX runner script", () => {
    const runner = SshTunnel.buildRemoteT3RunnerScript({
      archiveVersion: "0.1.12-nightly.20261125.5230",
    });
    assert.include(runner, 'T3_PLATFORM_KEY="win32-x64"');
    assert.include(runner, 'T3_PLATFORM_KEY="win32-arm64"');
    assert.include(runner, ".zip");
    assert.include(runner, "System32/tar.exe");
  });

  it.live("falls back to PowerShell when a Windows OpenSSH host rejects POSIX sh", () =>
    Effect.gen(function* () {
      const seenCommands: Array<ReadonlyArray<string>> = [];
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          const args = commandArgs(command);
          seenCommands.push(args);
          if (seenCommands.length === 1) {
            return Effect.succeed(
              makeProcess(
                "",
                "'sh' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n",
                1,
              ),
            );
          }
          return Effect.succeed(
            makeProcess('{"remotePort":3773,"serverKind":"external"}\r\n', "", 0),
          );
        }),
      );

      const result = yield* SshTunnel.launchOrReuseRemoteServer(
        { alias: "synthetic-win-host", hostname: "100.64.0.2", username: "dev", port: 22 },
        { batchMode: "yes", interactiveAuth: false },
        { archiveVersion: "0.1.12-nightly.20261125.5230" },
      ).pipe(
        Effect.provide(
          Layer.provideMerge(spawnerLayer, Layer.mergeAll(NodeCrypto.layer, NodeServices.layer)),
        ),
      );

      assert.strictEqual(result.remotePort, 3773);
      assert.strictEqual(result.remoteServerKind, "external");
      assert.strictEqual(result.remoteHostKind, "windows");
      assert.strictEqual(seenCommands.length, 2);
      assert.isTrue(seenCommands[0]?.includes("sh"));
      assert.isTrue(seenCommands[1]?.includes("-EncodedCommand"));
    }),
  );
});
