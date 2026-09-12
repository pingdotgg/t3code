import * as NodeCrypto from "node:crypto";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ProviderMaintenanceCommandAction } from "./providerMaintenance.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

const quotePowerShell = (value: string) => `'${value.replaceAll("'", "''")}'`;
const encodePowerShell = (value: string) => Buffer.from(value, "utf16le").toString("base64");
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

// Start-Process joins ArgumentList with spaces, so quote for the native argv parser.
const quoteWindowsArgument = (value: string) =>
  `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;

export const prepareWindowsUpdateElevation = Effect.fn("prepareWindowsUpdateElevation")(function* (
  update: ProviderMaintenanceCommandAction,
  timeoutMs: number,
  maxOutputBytes: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-update-" });
  const payloadPath = path.join(directory, "command.json");
  const cancelPath = path.join(directory, "cancel");
  const startedPath = path.join(directory, "started");
  const stdoutPath = path.join(directory, "stdout");
  const stderrPath = path.join(directory, "stderr");
  const env = { ...environment, ...update.env };
  const envKeys = new Set<string>();
  // Match Node's Windows spawn: the first sorted spelling wins. An array
  // also avoids PowerShell rejecting JSON properties such as Path and PATH.
  const variables = Object.keys(env)
    .sort()
    .flatMap((key) => {
      const canonical = key.toUpperCase();
      if (envKeys.has(canonical) || env[key] === undefined) return [];
      envKeys.add(canonical);
      return [[key, env[key]]];
    });
  const resolved = yield* resolveSpawnCommand(update.executable, update.args, {
    env,
    extendEnv: true,
  });
  const payload = yield* encodePayload({
    executable: resolved.shell
      ? path.join(environment.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe")
      : resolved.command,
    arguments: resolved.shell
      ? `/d /s /c "${[resolved.command, ...resolved.args].join(" ")}"`
      : resolved.args.map(quoteWindowsArgument).join(" "),
    env: variables,
    stdout: stdoutPath,
    stderr: stderrPath,
  });
  yield* fs.writeFileString(payloadPath, payload, { mode: 0o600 });
  const digest = NodeCrypto.createHash("sha256").update(payload).digest("hex");
  const powershell = path.join(
    environment.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  // The elevated worker owns the updater and its cancellation. Killing only
  // the unelevated launcher cannot stop an administrator process.
  const worker = `
$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllText(${quotePowerShell(startedPath)}, 'started')
$parent = Get-Process -Id __T3_PARENT_PID__ -ErrorAction Stop
$deadline = [DateTime]::Parse('__T3_DEADLINE__').ToUniversalTime()
$payloadPath = ${quotePowerShell(payloadPath)}
$cancelPath = ${quotePowerShell(cancelPath)}
$child = $null
try {
  if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne '__T3_USER_SID__') {
    throw 'The update must be approved by the same Windows user.'
  }
  $bytes = [IO.File]::ReadAllBytes($payloadPath)
  $hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
  if ($hash -ne '${digest}') { throw 'Update command changed before elevation.' }
  $config = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
  foreach ($variable in $config.env) {
    [Environment]::SetEnvironmentVariable($variable[0], $variable[1], 'Process')
  }
  if ((Test-Path -LiteralPath $cancelPath) -or [DateTime]::UtcNow -ge $deadline -or $parent.HasExited) { exit 1460 }
  $child = Start-Process -FilePath $config.executable -ArgumentList $config.arguments -WindowStyle Hidden -RedirectStandardOutput $config.stdout -RedirectStandardError $config.stderr -PassThru
  $null = $child.Handle
  while (-not $child.WaitForExit(200)) {
    if ($parent.HasExited -or (Test-Path -LiteralPath $cancelPath) -or [DateTime]::UtcNow -ge $deadline) { exit 1460 }
  }
  exit $child.ExitCode
} catch {
  [IO.File]::WriteAllText(${quotePowerShell(stderrPath)}, $_.Exception.Message)
  exit 1
} finally {
  if ($null -ne $child -and -not $child.HasExited) {
    & "$PSHOME\\..\\..\\taskkill.exe" /PID $child.Id /T /F | Out-Null
    if (-not $child.HasExited) { $child.Kill() }
    $child.WaitForExit()
  }
}
`;
  const launcher = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$worker = ${quotePowerShell(worker)}
$worker = $worker.Replace('__T3_PARENT_PID__', [string]$PID).Replace('__T3_USER_SID__', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value).Replace('__T3_DEADLINE__', [DateTime]::UtcNow.AddMilliseconds(${timeoutMs}).ToString('o'))
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($worker))
try {
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = ${quotePowerShell(powershell)}
  $start.Arguments = "-NoProfile -NonInteractive -EncodedCommand $encoded"
  $start.UseShellExecute = $true
  $start.Verb = 'runas'
  $start.WindowStyle = 'Hidden'
  $child = [Diagnostics.Process]::Start($start)
  $child.WaitForExit()
  exit $child.ExitCode
} catch {
  $failure = $_.Exception
  while ($null -ne $failure) {
    if ($failure -is [ComponentModel.Win32Exception] -and $failure.NativeErrorCode -eq 1223) { exit 1223 }
    $failure = $failure.InnerException
  }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
  return {
    command: powershell,
    args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(launcher)],
    cancel: fs
      .writeFileString(cancelPath, "cancel")
      .pipe(Effect.andThen(fs.exists(startedPath)), Effect.orDie),
    readOutput: Effect.all(
      [stdoutPath, stderrPath].map((file) =>
        collectUint8StreamText({ stream: fs.stream(file), maxBytes: maxOutputBytes }).pipe(
          Effect.orElseSucceed(() => ({ text: "", truncated: false })),
        ),
      ),
    ),
  };
});
