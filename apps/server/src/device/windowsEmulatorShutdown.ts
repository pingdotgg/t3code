import * as Effect from "effect/Effect";
import type { DeviceHostReady } from "./DeviceHost.ts";

export function prepareWindowsEmulatorShutdown(
  run: DeviceHostReady["run"],
  hubPid: number,
  serial: string,
) {
  const port = /^emulator-(\d{1,5})$/.exec(serial)?.[1];
  if (!port || !Number.isSafeInteger(hubPid) || hubPid <= 0) return Effect.succeed(null);

  // Match the exact port and the detached headless launcher started by this hub.
  const findOwner = String.raw`
$ErrorActionPreference = 'Stop'
$hub = Get-CimInstance Win32_Process -Filter 'ProcessId = ${hubPid}'
if ($null -eq $hub) { exit 1 }
$owned = @(Get-CimInstance Win32_Process -Filter "Name = 'emulator.exe' AND ParentProcessId = ${hubPid}" | Where-Object {
  $_.CreationDate -ge $hub.CreationDate -and
  $_.CommandLine -match '(?:^|\s)"?-no-window"?(?=\s|$)' -and
  $_.CommandLine -match '(?:^|\s)"?-port"?\s+"?${port}"?(?=\s|$)'
})
if ($owned.Count -ne 1) { exit 1 }
$owner = $owned[0]
$identity = "$($hub.CreationDate.ToUniversalTime().Ticks):$($owner.ProcessId):$($owner.CreationDate.ToUniversalTime().Ticks)"
`;
  const powershell = (script: string) =>
    run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        timeoutMs: 10_000,
        maxOutputBytes: 4_096,
      },
    );

  return powershell(`${findOwner}\nWrite-Output $identity`).pipe(
    Effect.map(({ code, stdout }) => {
      const identity = stdout.trim();
      if (code !== 0 || !/^\d+:\d+:\d+$/.test(identity)) return null;
      // A replacement on the same port, including a reused PID, is outside this shutdown.
      return () =>
        powershell(String.raw`${findOwner}
if ($identity -ne '${identity}') { exit 1 }
& "$env:SystemRoot\System32\taskkill.exe" /PID $owner.ProcessId /T /F
if ($LASTEXITCODE -ne 0) { exit 1 }
if (Get-CimInstance Win32_Process -Filter "ProcessId = $($owner.ProcessId)") { exit 1 }
`).pipe(Effect.map((result) => result.code === 0));
    }),
  );
}
