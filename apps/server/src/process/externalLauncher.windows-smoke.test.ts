// Scratch smoke test for #30954 (never merged): runs the launcher's PowerShell -Command through
// the real Windows PowerShell 5.1 and records what PowerShell parsed out of the argument.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ExternalLauncher from "./externalLauncher.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const hardPath = "C:\\T3 smoke\\author's $media & 50% ;x`tick é漢字🎉\\clip [1].mp4";
const hardParent = "C:\\T3 smoke\\author's $media & 50% ;x`tick é漢字🎉";
const hardUrl = "http://localhost:3773/pair?a=1&b=%20x;c=`d#token=a'b$c\"q";

const cases = [
  { kind: "browser", folderVerb: "none", expected: `Start-Process|${hardUrl}|` },
  { kind: "reveal", folderVerb: "none", expected: `Start-Process|explorer.exe|/select,"${hardPath}"` },
  { kind: "reveal", folderVerb: "", expected: `Start-Process|explorer.exe|/select,"${hardPath}"` },
  { kind: "reveal", folderVerb: "open", expected: `Invoke-Item|${hardParent}` },
] as const;

for (const { kind, folderVerb, expected } of cases) {
  it.live.skipIf(!windowsHost)(
    `real Windows PowerShell runs the plain -Command ${kind} script intact (folder verb: ${folderVerb || "empty"})`,
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-30954-"));
        const outputPath = NodePath.join(tempDir, "recorded.txt");
        const spawnedArgs: string[][] = [];
        try {
          const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const recordingSpawner = ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              assert.ok(ChildProcess.isStandardCommand(command));
              const args = command.args.map(String);
              spawnedArgs.push(args);
              const out = `'${outputPath.replaceAll("'", "''")}'`;
              // Stubs shadow the cmdlets so nothing opens; Record writes what PowerShell parsed.
              const handlers = [
                `function Record([string]$v) { [IO.File]::WriteAllText(${out}, $v, (New-Object Text.UTF8Encoding $false)) }`,
                `function Start-Process { param([string]$FilePath, [string[]]$ArgumentList) Record ('Start-Process|' + $FilePath + '|' + ($ArgumentList -join ' ')) }`,
                `function Invoke-Item { param([string]$LiteralPath) Record ('Invoke-Item|' + $LiteralPath) }`,
                `function Get-ItemProperty { [CmdletBinding()] param([string]$LiteralPath) @{ '(default)' = '${folderVerb}' } }`,
                "",
              ].join("; ");
              const exitCode = yield* realSpawner.exitCode(
                ChildProcess.make(
                  command.command,
                  [...args.slice(0, -1), handlers + (args.at(-1) ?? "")],
                  { ...command.options, stdout: "inherit", stderr: "inherit" },
                ),
              );
              assert.equal(Number(exitCode), 0, "powershell.exe exit code");
              return ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Effect.succeed(exitCode),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: Stream.empty,
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              });
            }),
          );
          const launcher = yield* ExternalLauncher.make.pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner),
          );
          if (kind === "browser") {
            yield* launcher.launchBrowser(hardUrl);
          } else {
            yield* launcher.launchEditor({ editor: "file-manager", cwd: hardPath, reveal: true });
          }
          console.log(`[30954] spawned args: ${JSON.stringify(spawnedArgs)}`);
          const recorded = NodeFS.readFileSync(outputPath, "utf8");
          console.log(`[30954] PowerShell recorded: ${recorded}`);
          assert.equal(recorded, expected);
          const flat = spawnedArgs.flat().map((arg) => arg.toLowerCase());
          assert.notInclude(flat, "-encodedcommand");
          assert.notInclude(flat, "-executionpolicy");
        } finally {
          NodeFS.rmSync(tempDir, { recursive: true, force: true });
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
