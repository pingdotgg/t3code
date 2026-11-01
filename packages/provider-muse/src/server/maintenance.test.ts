import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  compareMuseVersions,
  enrichMuseSnapshot,
  museMaintenance,
  parseMuseVersion,
} from "./maintenance.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";

const windowsShim = [
  "@echo off",
  "setlocal",
  '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0.muse-launcher.ps1" %*',
  "exit /b %ERRORLEVEL%",
].join("\r\n");
const windowsLauncherMarkers = "# muse-code/launcher-ps-3\n# MUSE_SYNC_UPDATE\n";
// Keep the official launcher's update structure, with inert download functions.
const windowsLauncher = `Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$launcher_url = 'https://api.meta.ai/muse-launcher.ps1'
$launcher_version = '3'
$user_agent = "muse-code/launcher-ps-$launcher_version"
function Update-Launcher {
  param([string]$Self)
}
function Update-Binary {
  param([string]$Dir)
}
function Get-ActiveBinary {
  param([string]$Dir)
  return 'muse.exe'
}
function Invoke-Main {
  $self = $PSCommandPath
  $dir = Split-Path -Parent $self
  if ($env:MUSE_SYNC_UPDATE -eq '1') {
    Update-Launcher -Self $self
    Update-Binary -Dir $dir
    $binary = Get-ActiveBinary -Dir $dir
  }
}
Invoke-Main @args
`;

const maintenanceCapabilities = {
  ...makeManualOnlyProviderMaintenanceCapabilities({
    provider: ProviderDriverKind.make("muse"),
    packageName: null,
  }),
  compareVersions: compareMuseVersions,
};
const snapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("muse"),
  driver: ProviderDriverKind.make("muse"),
  enabled: true,
  installed: true,
  version: "1.0.3",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-09-10T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
};

it.layer(NodeServices.layer)("Muse maintenance", (it) => {
  it.effect(
    "compares numeric native release revisions and preserves the CLI release identity",
    () =>
      Effect.sync(() => {
        expect(parseMuseVersion("Muse Code 1.1.1 (1.1.1-R2514.1)")).toBe("1.1.1-R2514.1");
        expect(compareMuseVersions("1.1.1-R9.1", "1.1.1-R10.1")).toBeLessThan(0);
        expect(compareMuseVersions("1.1.1-R2514.1", "1.1.1-R2514.2")).toBeLessThan(0);
        expect(compareMuseVersions("1.2.0-R1.1", "1.1.1-R2514.2")).toBeGreaterThan(0);
        expect(compareMuseVersions("1.4.3", "1.4.3-R5018.1")).toBe(0);
        expect(compareMuseVersions("1.4.2", "1.4.3-R5018.1")).toBeLessThan(0);
      }),
  );

  it.effect("tolerates invalid release manifests and unavailable channels", () =>
    Effect.gen(function* () {
      for (const response of [
        Response.json({ version: 12 }),
        Response.json({ version: "1.1.1" }),
        new Response("unavailable", { status: 503 }),
      ]) {
        const result = yield* enrichMuseSnapshot({
          snapshot,
          maintenanceCapabilities,
          enableProviderUpdateChecks: true,
          environment: {},
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, response)),
            ),
          ),
          Effect.provide(ProviderLatestVersions.layer),
        );
        expect(result.status).toBe("ready");
        expect(result.versionAdvisory?.status).toBe("unknown");
      }
    }),
  );

  it.effect("updates only a recognized launcher at the resolved instance path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-maintenance-" });
        const binaryPath = `${directory}/custom muse`;
        const context = {
          binaryPath,
          resolvedCommandPath: binaryPath,
          realCommandPath: binaryPath,
          platform: "linux" as const,
          env: { MUSE_CHANNEL: "muse-canary" },
        };
        yield* fs.writeFileString(
          binaryPath,
          "#!/bin/bash\n# muse-code/launcher-2\n# MUSE_SYNC_UPDATE\n",
        );
        const result = yield* museMaintenance.resolve(context);
        expect(result.update).toMatchObject({
          executable: binaryPath,
          args: ["--version"],
          lockKey: `muse:${binaryPath}`,
          env: {
            MUSE_CHANNEL: "muse-canary",
            MUSE_NO_AUTO_UPDATE: "0",
            MUSE_SYNC_UPDATE: "1",
            MUSE_UPDATE_INTERVAL_SECONDS: "0",
          },
        });
        expect(result.update?.command).toBe(
          `MUSE_CHANNEL=muse-canary MUSE_NO_AUTO_UPDATE=0 MUSE_SYNC_UPDATE=1 MUSE_UPDATE_INTERVAL_SECONDS=0 '${binaryPath}' --version`,
        );
        expect(result.compareVersions).toBe(compareMuseVersions);
        yield* fs.writeFileString(binaryPath, "standalone binary");
        expect((yield* museMaintenance.resolve(context)).update).toBeNull();
        expect((yield* museMaintenance.resolve(null)).update).toBeNull();
      }),
    ),
  );

  it.effect("resolves official Windows shims using the instance's path and environment", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-maintenance-" });
      const installation = path.join(directory, "Muse R&D (canary) @ ^ ' $ %PATH%");
      yield* fs.makeDirectory(installation);
      const shim = path.join(installation, "muse.cmd");
      const launcher = path.join(installation, ".muse-launcher.ps1");
      yield* fs.writeFileString(shim, windowsShim);
      yield* fs.writeFileString(launcher, windowsLauncher);
      const env = {
        PATH: installation,
        PATHEXT: ".EXE;.CMD",
        SystemRoot: "C:\\Windows",
        MUSE_CHANNEL: "muse-canary",
        MUSE_NO_AUTO_UPDATE: "1",
        MUSE_SYNC_UPDATE: "0",
        MUSE_UPDATE_INTERVAL_SECONDS: "3600",
        MUSE_AUTH_PATH: "custom credentials",
      };
      for (const binaryPath of ["muse", path.join(installation, "muse")]) {
        const result = yield* resolveProviderMaintenanceCapabilitiesEffect(museMaintenance, {
          binaryPath,
          env,
        }).pipe(Effect.provideService(HostProcess.Platform, "win32"));
        expect(result.update).toMatchObject({
          executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "--version"],
          env: {
            ...env,
            MUSE_NO_AUTO_UPDATE: "0",
            MUSE_SYNC_UPDATE: "1",
            MUSE_UPDATE_INTERVAL_SECONDS: "0",
          },
        });
        expect(result.update?.lockKey.toLowerCase()).toBe(
          `muse:${yield* fs.realPath(launcher)}`.toLowerCase(),
        );
        expect(result.update?.command).toContain("$env:MUSE_CHANNEL='muse-canary';");
        expect(result.update?.command).toContain("$env:MUSE_NO_AUTO_UPDATE='0';");
        expect(result.update?.command).toContain("$env:MUSE_SYNC_UPDATE='1';");
        expect(result.update?.command).toContain("$env:MUSE_UPDATE_INTERVAL_SECONDS='0';");
        expect(result.update?.command).toContain("'-File' '");
        expect(result.update?.command).toContain(" ^ '' $ %PATH%");
        expect(result.compareVersions).toBe(compareMuseVersions);
      }
      expect(env.MUSE_NO_AUTO_UPDATE).toBe("1");
    }).pipe(Effect.scoped),
  );

  it.effect("resolves a configured PowerShell launcher with default Windows command lookup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-maintenance-" });
      const launcher = path.join(directory, ".muse-launcher.ps1");
      yield* fs.writeFileString(launcher, windowsLauncher);
      const result = yield* resolveProviderMaintenanceCapabilitiesEffect(museMaintenance, {
        binaryPath: launcher,
        env: { SYSTEMROOT: "D:\\Windows" },
      }).pipe(Effect.provideService(HostProcess.Platform, "win32"));
      expect(result.update).toMatchObject({
        executable: "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "--version"],
        lockKey: `muse:${launcher}`,
      });
      expect(result.update?.env).not.toHaveProperty("MUSE_CHANNEL");
      expect(result.update?.env).not.toHaveProperty("PATHEXT");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps standalone Windows binaries and unrecognized wrappers manual-only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-maintenance-" });
      const launcher = path.join(directory, ".muse-launcher.ps1");
      for (const [name, source, adjacentSource] of [
        ["muse.exe", windowsLauncher, windowsLauncher],
        ["muse.cmd", "@echo off\r\nmuse --version %*", windowsLauncher],
        ["muse.cmd", windowsShim.replace("%~dp0", "C:\\other\\"), windowsLauncher],
        ["muse.cmd", windowsShim + "\r\nother-command", windowsLauncher],
        ["muse.cmd", windowsShim, "# MUSE_SYNC_UPDATE"],
        ["muse.cmd", windowsShim, "# muse-code/launcher-ps-3"],
        ["muse.cmd", windowsShim, windowsLauncher + " ".repeat(128 * 1_024)],
        ["muse.cmd", windowsShim, null],
        ["muse.ps1", "# unrecognized wrapper", windowsLauncher],
      ] as const) {
        const binaryPath = path.join(directory, name);
        yield* fs.writeFileString(binaryPath, source);
        if (adjacentSource === null) yield* fs.remove(launcher);
        else yield* fs.writeFileString(launcher, adjacentSource);
        expect(
          (yield* museMaintenance.resolve({
            binaryPath,
            resolvedCommandPath: binaryPath,
            realCommandPath: binaryPath,
            platform: "win32",
            env: {},
          })).update,
        ).toBeNull();
      }
    }).pipe(Effect.scoped),
  );

  it.effect("rejects marker-only Windows launchers and incomplete official update structures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-maintenance-" });
      for (const source of [
        windowsLauncherMarkers,
        windowsLauncherMarkers + "Write-Output 'unrecognized wrapper'\n",
        windowsLauncher.replace("Set-StrictMode -Version Latest", "# custom wrapper"),
        windowsLauncher.replace(
          "https://api.meta.ai/muse-launcher.ps1",
          "https://example.com/wrapper.ps1",
        ),
        windowsLauncher.replace("function Update-Binary {", "function Other-Update {"),
        windowsLauncher.replace("$self = $PSCommandPath", "$self = 'other.ps1'"),
        windowsLauncher.replace("Update-Binary -Dir $dir", "Write-Output 'no update'"),
        windowsLauncher.replace("Invoke-Main @args", "Write-Output 'no entry point'"),
      ]) {
        const launcher = path.join(directory, ".muse-launcher.ps1");
        yield* fs.writeFileString(launcher, source);
        const shim = path.join(directory, "muse.cmd");
        yield* fs.writeFileString(shim, windowsShim);
        for (const binaryPath of [launcher, shim]) {
          expect(
            (yield* museMaintenance.resolve({
              binaryPath,
              resolvedCommandPath: binaryPath,
              realCommandPath: binaryPath,
              platform: "win32",
              env: {},
            })).update,
          ).toBeNull();
        }
      }
    }).pipe(Effect.scoped),
  );
});

it.live(
  "runs direct and copied Windows update commands with literal paths and forced environment",
  () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "muse-maintenance-" }),
        "Muse R&D (canary) @ ^ ' \u2018 \u2019 \u201a \u201b $; %PATH%",
      );
      yield* fs.makeDirectory(directory);
      const shim = path.join(directory, "muse.cmd");
      yield* fs.writeFileString(shim, windowsShim);
      yield* fs.writeFileString(
        path.join(directory, ".muse-launcher.ps1"),
        windowsLauncher.replace(
          "    $binary = Get-ActiveBinary -Dir $dir",
          '    $binary = Get-ActiveBinary -Dir $dir\n    [Console]::WriteLine(($args -join ",") + "|" + $env:MUSE_CHANNEL + "|" + $env:MUSE_NO_AUTO_UPDATE + "|" + $env:MUSE_SYNC_UPDATE + "|" + $env:MUSE_UPDATE_INTERVAL_SECONDS + "|" + $env:MUSE_AUTH_PATH)',
        ),
      );
      const capabilities = yield* museMaintenance.resolve({
        binaryPath: "muse",
        resolvedCommandPath: shim,
        realCommandPath: shim,
        platform: "win32",
        env: { MUSE_CHANNEL: "muse-canary", MUSE_NO_AUTO_UPDATE: "1", MUSE_AUTH_PATH: "kept" },
      });
      expect(capabilities.update).not.toBeNull();
      const update = capabilities.update!;
      const resolved = yield* resolveSpawnCommand(update.executable, update.args);
      expect(resolved.shell).toBe(false);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      for (const command of [
        resolved,
        {
          command: update.executable,
          // Preserve Unicode through the CLI transport; PowerShell still parses the copied command.
          args: [
            "-NoProfile",
            "-EncodedCommand",
            Buffer.from(update.command, "utf16le").toString("base64"),
          ],
          shell: false,
        },
      ]) {
        const child = yield* spawner.spawn(
          ChildProcess.make(command.command, command.args, {
            env: update.env,
            extendEnv: true,
            shell: command.shell,
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        expect(Number(exitCode), stderr).toBe(0);
        expect(stdout.trim()).toBe("--version|muse-canary|0|1|0|kept");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
