import type { ToolActivityNativeAppReference } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import { existingFile, type NativeAppIconSource } from "./source.ts";

const COMMAND_TIMEOUT = "10 seconds";

/**
 * Finds the app's executable and writes its icon as a PNG. Windows has no
 * bundle ids, so Cua names an app by its display or process name: the script
 * prefers a running process of that name, then the Start Menu shortcut with
 * that name. Arguments travel as environment variables so the name is never
 * spliced into the script.
 */
const EXTRACT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$name = $env:T3_APP_NAME
$exe = $null
$process = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and ($_.ProcessName -ieq $name -or $_.MainWindowTitle -ieq $name -or $_.Product -ieq $name) } |
  Select-Object -First 1
if ($process) { $exe = $process.Path }
if (-not $exe) {
  $shell = New-Object -ComObject WScript.Shell
  $roots = @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:AppData\\Microsoft\\Windows\\Start Menu\\Programs")
  $link = Get-ChildItem -Path $roots -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -ieq $name } | Select-Object -First 1
  if ($link) { $exe = $shell.CreateShortcut($link.FullName).TargetPath }
}
if (-not $exe -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) { exit 3 }
Write-Output $exe
if ($env:T3_ICON_OUT) {
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
  $bitmap = $icon.ToBitmap()
  $bitmap.Save($env:T3_ICON_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
}
`;

const runScript = Effect.fn("NativeAppIconResolver.win32.runScript")(function* (
  env: Record<string, string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .string(
      ChildProcess.make(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", EXTRACT_SCRIPT],
        { stdin: "ignore", stderr: "ignore", env, extendEnv: true },
      ),
    )
    .pipe(Effect.timeout(COMMAND_TIMEOUT));
});

const resolveIcon = Effect.fn("NativeAppIconResolver.win32.resolve")(function* (
  app: ToolActivityNativeAppReference,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const name = (app._tag === "display-name" ? app.displayName : app.appId).trim();
  if (name.length === 0 || /[\\/:*?"<>|]/u.test(name)) return null;

  // The first run only locates the executable; its path and size key the cache.
  const executable = (yield* runScript({ T3_APP_NAME: name })).trim();
  if (!executable) return null;
  const info = yield* fileSystem.stat(executable);
  const crypto = yield* Crypto.Crypto;
  const cacheKey = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(`${executable}\0${info.size}`))
    .pipe(Effect.map(Hex.encode), Effect.orDie);
  const cacheDirectory = path.join(config.providerStatusCacheDir, "native-app-icons");
  const cachePath = path.join(cacheDirectory, `${cacheKey}.png`);
  if (yield* existingFile(cachePath)) return cachePath;

  yield* fileSystem.makeDirectory(cacheDirectory, { recursive: true });
  const temporaryPath = path.join(
    cacheDirectory,
    `.${cacheKey}-${process.pid}-${(yield* Clock.currentTimeMillis).toString(36)}.png`,
  );
  yield* runScript({ T3_APP_NAME: name, T3_ICON_OUT: temporaryPath }).pipe(
    Effect.tap(() => fileSystem.rename(temporaryPath, cachePath)),
    Effect.ensuring(
      fileSystem.remove(temporaryPath).pipe(Effect.catchTags({ PlatformError: () => Effect.void })),
    ),
  );
  return yield* existingFile(cachePath);
});

/**
 * Cua reports a Windows app by its name. PowerShell finds the executable
 * (a running process first, then a Start Menu shortcut) and System.Drawing
 * renders its associated icon to a cached PNG.
 */
export const win32Source: NativeAppIconSource = {
  platform: "win32",
  resolve: resolveIcon,
};
