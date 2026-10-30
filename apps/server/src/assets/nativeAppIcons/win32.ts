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
 * Packaged apps use their manifest logo; a shared ApplicationFrameHost
 * executable cannot identify their icon. Arguments travel as environment
 * variables so the name is never spliced into the script.
 */
export const WINDOWS_APP_ICON_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$name = $env:T3_APP_NAME
$exe = $null
$packaged = Get-StartApps | Where-Object { $_.Name -ieq $name -or $_.AppID -ieq $name } | Select-Object -First 1
if ($packaged -and $packaged.AppID -match '^([^!]+)!(.+)$') {
  $family = $Matches[1]
  $applicationId = $Matches[2]
  $package = Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq $family } | Select-Object -First 1
  if ($package) {
    $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
    $application = $manifest.Package.Applications.Application | Where-Object { $_.Id -eq $applicationId } | Select-Object -First 1
    $logo = $application.VisualElements.Square44x44Logo
    if ($logo) {
      $logoPath = Join-Path $package.InstallLocation $logo
      $directory = Split-Path $logoPath
      $stem = [IO.Path]::GetFileNameWithoutExtension($logoPath)
      $extension = [IO.Path]::GetExtension($logoPath)
      $candidates = @("$stem.targetsize-32_altform-unplated$extension", "$stem.targetsize-48_altform-unplated$extension", "$stem.scale-200$extension", "$stem$extension")
      foreach ($candidate in $candidates) {
        $file = Join-Path $directory $candidate
        if (Test-Path -LiteralPath $file -PathType Leaf) { $exe = $file; break }
      }
      if (-not $exe) {
        $exe = Get-ChildItem -LiteralPath $directory -Filter "$stem.*$extension" -ErrorAction SilentlyContinue |
          Sort-Object Name | Select-Object -First 1 -ExpandProperty FullName
      }
    }
  }
}
$processName = [IO.Path]::GetFileNameWithoutExtension($name)
$process = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.ProcessName -notin @('ApplicationFrameHost', 'WWAHost') -and ($_.ProcessName -ieq $processName -or $_.MainWindowTitle -ieq $name -or $_.Product -ieq $name) } |
  Select-Object -First 1
if (-not $exe -and $process) { $exe = $process.Path }
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
  $icon = $null
  $bitmap = $null
  try {
    if ([IO.Path]::GetExtension($exe) -ieq '.png') {
      $bitmap = [System.Drawing.Image]::FromFile($exe)
    } else {
      $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
      $bitmap = $icon.ToBitmap()
    }
    $bitmap.Save($env:T3_ICON_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    if ($bitmap) { $bitmap.Dispose() }
    if ($icon) { $icon.Dispose() }
  }
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
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          WINDOWS_APP_ICON_SCRIPT,
        ],
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

  // The source image or executable and its size key the cache.
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

/** Resolves packaged-app logos and traditional executable icons on the host. */
export const win32Source: NativeAppIconSource = {
  platform: "win32",
  resolve: resolveIcon,
};
