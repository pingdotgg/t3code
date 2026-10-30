// @effect-diagnostics nodeBuiltinImport:off - Runs the Windows icon script against an isolated package fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { WINDOWS_APP_ICON_SCRIPT } from "./win32.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This integration test needs Windows PowerShell on the physical test host.
describe.runIf(NodeOS.platform() === "win32")("Windows packaged app icons", () => {
  it("uses a package's unplated logo for both its name and AUMID", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-packaged-icon-"));
    const fixture = `
Add-Type -AssemblyName System.Drawing
$image = New-Object System.Drawing.Bitmap 1, 1
try {
  $image.SetPixel(0, 0, [System.Drawing.Color]::Red)
  $image.Save((Join-Path $env:T3_TEST_PACKAGE 'App.targetsize-32_altform-unplated.png'))
} finally { $image.Dispose() }
function Get-StartApps { [pscustomobject]@{ Name = 'Fixture Calculator'; AppID = 'Fixture_family!App' } }
function Get-AppxPackage { [pscustomobject]@{ PackageFamilyName = 'Fixture_family'; PackageFullName = 'Fixture'; InstallLocation = $env:T3_TEST_PACKAGE } }
function Get-AppxPackageManifest { [xml]'<Package><Applications><Application Id="App"><VisualElements Square44x44Logo="App.png" /></Application></Applications></Package>' }
function Get-Process { [pscustomobject]@{ ProcessName = 'ApplicationFrameHost'; MainWindowTitle = 'Fixture Calculator'; Path = 'C:\\Windows\\System32\\ApplicationFrameHost.exe' } }
`;
    try {
      for (const name of ["Fixture Calculator", "Fixture_family!App"]) {
        const outputPath = NodePath.join(root, "output.png");
        const source = NodeChildProcess.execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", fixture + WINDOWS_APP_ICON_SCRIPT],
          {
            windowsHide: true,
            timeout: 10_000,
            encoding: "utf8",
            env: {
              ...process.env,
              T3_TEST_PACKAGE: root,
              T3_APP_NAME: name,
              T3_ICON_OUT: outputPath,
            },
          },
        ).trim();
        expect(source).toBe(NodePath.join(root, "App.targetsize-32_altform-unplated.png"));
        expect([...NodeFS.readFileSync(outputPath).subarray(0, 8)]).toEqual([
          137, 80, 78, 71, 13, 10, 26, 10,
        ]);
      }
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
