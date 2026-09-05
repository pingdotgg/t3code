// @effect-diagnostics nodeBuiltinImport:off

// Pure Windows installer contracts.  The actual NSIS compiler is only
// available on Windows CI; keeping payload discovery, hashes, mode state, and
// command rendering here makes the important parts testable on Linux.

import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const WINDOWS_SETUP_MODES = ["full", "controller", "headless"] as const;
export type WindowsSetupMode = (typeof WINDOWS_SETUP_MODES)[number];
export type WindowsSetupArch = "x64" | "arm64";

export const WINDOWS_SETUP_TASK_NAME = "Jarvis Headless Node";
export const WINDOWS_SETUP_DATA_ROOT = "%USERPROFILE%\\.jarvis";
export const WINDOWS_SETUP_UNINSTALL_REGISTRY_KEY =
  "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Jarvis";
/** electron-builder 26's deterministic NSIS key for the shipped Companion appId. */
export const LEGACY_COMPANION_APP_GUID = "0f1dda33-2afd-5844-b03e-82589eb138e8";
export const LEGACY_COMPANION_INSTALL_REGISTRY_KEY = `Software\\${LEGACY_COMPANION_APP_GUID}`;
export const LEGACY_COMPANION_UNINSTALL_REGISTRY_KEY = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${LEGACY_COMPANION_APP_GUID}`;

export interface WindowsSetupPayloadFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface WindowsSetupPayload {
  readonly id: "desktop" | "runtime-win";
  readonly modes: ReadonlyArray<WindowsSetupMode>;
  readonly files: ReadonlyArray<WindowsSetupPayloadFile>;
}

export interface WindowsSetupManifest {
  readonly format: 3;
  readonly product: "Jarvis";
  readonly version: string;
  readonly platform: "windows";
  readonly arch: WindowsSetupArch;
  readonly artifactName: string;
  readonly sourceCommit: string;
  readonly payloads: ReadonlyArray<WindowsSetupPayload>;
}

export interface WindowsSetupManifestInput {
  readonly version: string;
  readonly arch: WindowsSetupArch;
  readonly sourceCommit: string;
  readonly payloadDirectories: Readonly<{
    readonly desktop: string;
    readonly runtimeWin: string;
  }>;
}

export interface WindowsSetupProvenance {
  readonly format: 1;
  readonly product: "Jarvis";
  readonly artifactName: string;
  readonly artifactSha256: string;
  readonly aliasName: string;
  readonly manifestName: string;
  readonly manifestSha256: string;
  readonly provenanceName: string;
  readonly sourceCommit: string;
  readonly version: string;
  readonly arch: WindowsSetupArch;
}

export interface WindowsSetupProvenanceInput {
  readonly artifactName: string;
  readonly artifactSha256: string;
  readonly aliasName: string;
  readonly manifestName: string;
  readonly manifestSha256: string;
  readonly provenanceName: string;
  readonly sourceCommit: string;
  readonly version: string;
  readonly arch: WindowsSetupArch;
}

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const WINDOWS_ARCHES = new Set<WindowsSetupArch>(["x64", "arm64"]);

function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Windows setup version must be exact semver, received '${version}'.`);
  }
}

export function assertWindowsSetupSourceCommit(value: string): void {
  if (!SOURCE_COMMIT_PATTERN.test(value)) {
    throw new Error(`Windows setup source commit must be a full SHA-1, received '${value}'.`);
  }
}

export function assertWindowsSetupArch(value: string): asserts value is WindowsSetupArch {
  if (!WINDOWS_ARCHES.has(value as WindowsSetupArch)) {
    throw new Error(`Windows setup architecture must be x64 or arm64, received '${value}'.`);
  }
}

export function windowsSetupArtifactName(version: string, arch: WindowsSetupArch): string {
  assertVersion(version);
  return `Jarvis-Setup-${version}-win-${arch}.exe`;
}

export function windowsSetupManifestName(version: string, arch: WindowsSetupArch): string {
  return `${windowsSetupArtifactName(version, arch)}.manifest.json`;
}

export function windowsSetupProvenanceName(version: string, arch: WindowsSetupArch): string {
  return `${windowsSetupArtifactName(version, arch)}.provenance.json`;
}

export function windowsSetupAliasName(): string {
  return "Jarvis-Setup.exe";
}

export function windowsSetupModeCapabilities(mode: WindowsSetupMode) {
  return {
    ui: mode !== "headless",
    parakeet: mode !== "headless",
    kokoro: mode !== "headless",
    pocket: mode !== "headless",
    execution: mode !== "controller",
    projects: mode !== "controller",
    providers: mode !== "controller",
  } as const;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll(NodePath.sep, "/");
  if (normalized.startsWith("../") || normalized === ".." || NodePath.isAbsolute(normalized)) {
    throw new Error(`Payload path escapes its staging root: ${value}`);
  }
  return normalized;
}

async function collectPayloadFiles(
  rootDir: string,
): Promise<ReadonlyArray<WindowsSetupPayloadFile>> {
  const output: Array<WindowsSetupPayloadFile> = [];

  async function visit(directory: string): Promise<void> {
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Payload contains unsupported non-file entry: ${absolutePath}`);
      }
      const bytes = await NodeFSP.readFile(absolutePath);
      output.push({
        path: normalizeRelativePath(NodePath.relative(rootDir, absolutePath)),
        bytes: bytes.byteLength,
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }

  await visit(rootDir);
  return output;
}

export async function createWindowsSetupManifest(
  input: WindowsSetupManifestInput,
): Promise<WindowsSetupManifest> {
  assertVersion(input.version);
  assertWindowsSetupArch(input.arch);
  assertWindowsSetupSourceCommit(input.sourceCommit);
  const payloads = await Promise.all([
    collectPayloadFiles(input.payloadDirectories.desktop).then((files) => ({
      id: "desktop" as const,
      modes: ["full", "controller"] as const,
      files,
    })),
    collectPayloadFiles(input.payloadDirectories.runtimeWin).then((files) => ({
      id: "runtime-win" as const,
      modes: ["headless"] as const,
      files,
    })),
  ]);
  return {
    format: 3,
    product: "Jarvis",
    version: input.version,
    platform: "windows",
    arch: input.arch,
    artifactName: windowsSetupArtifactName(input.version, input.arch),
    sourceCommit: input.sourceCommit,
    payloads,
  };
}

export function createWindowsSetupProvenance(
  input: WindowsSetupProvenanceInput,
): WindowsSetupProvenance {
  assertVersion(input.version);
  assertWindowsSetupArch(input.arch);
  assertWindowsSetupSourceCommit(input.sourceCommit);
  for (const [label, value] of [
    ["artifact", input.artifactSha256],
    ["manifest", input.manifestSha256],
  ] as const) {
    if (!SHA256_PATTERN.test(value)) {
      throw new Error(`Windows setup ${label} SHA-256 must be 64 lowercase hex characters.`);
    }
  }
  return {
    format: 1,
    product: "Jarvis",
    artifactName: input.artifactName,
    artifactSha256: input.artifactSha256,
    aliasName: input.aliasName,
    manifestName: input.manifestName,
    manifestSha256: input.manifestSha256,
    provenanceName: input.provenanceName,
    sourceCommit: input.sourceCommit,
    version: input.version,
    arch: input.arch,
  };
}

export function renderNodePresetJson(mode: WindowsSetupMode): string {
  const capabilities = windowsSetupModeCapabilities(mode);
  return `${JSON.stringify(
    {
      product: "Jarvis",
      preset: mode,
      nodeType: mode,
      capabilities,
    },
    null,
    2,
  )}\n`;
}

/** Stable launcher used by Task Scheduler. It does not depend on PATH. */
export function renderWindowsNodeSupervisorMjs(): string {
  return [
    'import { existsSync } from "node:fs";',
    'import { join, dirname } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'import { spawn } from "node:child_process";',
    "",
    "const runtimeRoot = dirname(fileURLToPath(import.meta.url));",
    'const home = process.env.T3CODE_HOME || join(process.env.USERPROFILE || "", ".jarvis");',
    'const stopMarker = process.env.JARVIS_NODE_STOP || join(home, "runtime", "windows-stop.marker");',
    'const childArgs = [join(runtimeRoot, "dist", "bin.mjs"), "--mode", "web", "--no-browser", "--port", "3773", "--jarvis-node-preset", "headless"];',
    'const childEnvironment = { ...process.env, JARVIS_NODE_PRESET: "headless" };',
    "let child = null;",
    "let restartTimer = null;",
    "let stopping = false;",
    "let finished = false;",
    "",
    "function clearRestartTimer() {",
    "  if (restartTimer !== null) {",
    "    clearTimeout(restartTimer);",
    "    restartTimer = null;",
    "  }",
    "}",
    "",
    "function finish() {",
    "  if (finished) return;",
    "  finished = true;",
    "  clearRestartTimer();",
    "  clearInterval(stopPoll);",
    "  process.exit(0);",
    "}",
    "",
    "function scheduleRestart() {",
    "  if (stopping || finished || restartTimer !== null) return;",
    "  restartTimer = setTimeout(() => {",
    "    restartTimer = null;",
    "    startChild();",
    "  }, 5000);",
    "}",
    "",
    "function childEnded(current) {",
    "  if (child !== current) return;",
    "  child = null;",
    "  if (stopping) finish();",
    "  else scheduleRestart();",
    "}",
    "",
    "function startChild() {",
    "  if (stopping || finished || child !== null) return;",
    "  if (existsSync(stopMarker)) {",
    "    stopping = true;",
    "    finish();",
    "    return;",
    "  }",
    "  let current;",
    "  try {",
    '    current = spawn(process.execPath, childArgs, { cwd: runtimeRoot, env: childEnvironment, stdio: "inherit" });',
    "  } catch {",
    "    scheduleRestart();",
    "    return;",
    "  }",
    "  child = current;",
    '  current.once("error", () => childEnded(current));',
    '  current.once("exit", () => childEnded(current));',
    "}",
    "",
    "function requestStop() {",
    "  if (stopping) return;",
    "  stopping = true;",
    "  clearRestartTimer();",
    "  if (child !== null) terminateChild(child);",
    "  else finish();",
    "}",
    "",
    "function terminateChild(current) {",
    '  const taskkill = process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "taskkill.exe") : null;',
    "  if (taskkill) {",
    "    try {",
    '      const killer = spawn(taskkill, ["/PID", String(current.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });',
    '      killer.once("error", () => { if (current.exitCode === null) current.kill(); });',
    '      killer.once("exit", (code) => { if (code !== 0 && current.exitCode === null) current.kill(); });',
    "      return;",
    "    } catch {",
    "      // Fall through to the direct child signal when taskkill cannot start.",
    "    }",
    "  }",
    "  current.kill();",
    "}",
    "",
    "const stopPoll = setInterval(() => {",
    "  if (existsSync(stopMarker)) requestStop();",
    "}, 250);",
    'process.on("SIGTERM", requestStop);',
    'process.on("SIGINT", requestStop);',
    "startChild();",
    "",
  ].join("\n");
}

export function renderWindowsNodeStopPs1(): string {
  return [
    "param([Parameter(Mandatory = $true)][string] $RuntimeRoot)",
    "$ErrorActionPreference = 'Stop'",
    "$bundledNode = [System.IO.Path]::GetFullPath((Join-Path $RuntimeRoot 'node\\node.exe'))",
    "$taskkill = Join-Path $env:SystemRoot 'System32\\taskkill.exe'",
    "function Get-BundledNodeProcess {",
    "  @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object {",
    "    $_.ExecutablePath -and [System.String]::Equals(",
    "      [System.IO.Path]::GetFullPath($_.ExecutablePath),",
    "      $bundledNode,",
    "      [System.StringComparison]::OrdinalIgnoreCase",
    "    )",
    "  })",
    "}",
    "$bundledProcesses = @(Get-BundledNodeProcess)",
    "foreach ($process in $bundledProcesses) {",
    "  & $taskkill /PID $process.ProcessId /T /F | Out-Null",
    "}",
    "for ($attempt = 0; $attempt -lt 50; $attempt++) {",
    "  $remaining = @(Get-BundledNodeProcess)",
    "  if ($remaining.Count -eq 0) { exit 0 }",
    "  Start-Sleep -Milliseconds 100",
    "}",
    "Write-Error \"Bundled runtime Node processes remain after stop: $($remaining.ProcessId -join ', ')\"",
    "exit 1",
    "",
  ].join("\r\n");
}

/** Stop only Jarvis processes whose executable path is owned by this install. */
export function renderWindowsOwnedProcessStopPs1(): string {
  return [
    "param(",
    "  [Parameter(Mandatory = $true)][string] $DesktopPath,",
    "  [Parameter(Mandatory = $true)][string] $CompanionPath,",
    "  [string] $LegacyCompanionPath",
    ")",
    "$ErrorActionPreference = 'Stop'",
    "$candidatePaths = @($DesktopPath, $CompanionPath, $LegacyCompanionPath)",
    "$allowedByPath = @{}",
    "foreach ($candidate in $candidatePaths) {",
    "  if ([string]::IsNullOrWhiteSpace($candidate)) { continue }",
    "  $full = [System.IO.Path]::GetFullPath($candidate)",
    "  $allowedByPath[$full.ToLowerInvariant()] = $true",
    "}",
    "if ($allowedByPath.Count -eq 0) { Write-Error 'No owned executable paths were supplied.'; exit 1 }",
    "$taskkill = Join-Path $env:SystemRoot 'System32\\taskkill.exe'",
    "function Get-OwnedJarvisProcess {",
    "  $candidates = @(",
    "    @(Get-CimInstance Win32_Process -Filter \"Name = 'Jarvis.exe'\"),",
    "    @(Get-CimInstance Win32_Process -Filter \"Name = 'Jarvis Companion.exe'\")",
    "  )",
    "  @($candidates | Where-Object {",
    "    if (-not $_.ExecutablePath) { return $false }",
    "    try {",
    "      $path = [System.IO.Path]::GetFullPath($_.ExecutablePath).ToLowerInvariant()",
    "      return $allowedByPath.ContainsKey($path)",
    "    } catch { return $false }",
    "  })",
    "}",
    "try {",
    "  $owned = @(Get-OwnedJarvisProcess)",
    "  foreach ($process in $owned) {",
    "    & $taskkill /PID $process.ProcessId /T /F | Out-Null",
    "  }",
    "  for ($attempt = 0; $attempt -lt 50; $attempt++) {",
    "    $remaining = @(Get-OwnedJarvisProcess)",
    "    if ($remaining.Count -eq 0) { exit 0 }",
    "    Start-Sleep -Milliseconds 100",
    "  }",
    "  $ids = ($remaining | ForEach-Object { $_.ProcessId }) -join ', '",
    '  Write-Error "Owned Jarvis processes remain after stop: $ids"',
    "  exit 1",
    "} catch {",
    '  Write-Error "Could not safely stop owned Jarvis processes: $($_.Exception.Message)"',
    "  exit 1",
    "}",
    "",
  ].join("\r\n");
}

export function renderWindowsNodeLauncherCmd(): string {
  return [
    "@echo off",
    "setlocal enableextensions",
    `set "T3CODE_HOME=%USERPROFILE%\\.jarvis"`,
    `set "JARVIS_NODE_PRESET=headless"`,
    `set "JARVIS_NODE_STOP=%T3CODE_HOME%\\runtime\\windows-stop.marker"`,
    'cd /d "%~dp0"',
    ":run_supervisor",
    'if exist "%JARVIS_NODE_STOP%" exit /b 0',
    `"%~dp0node\\node.exe" "%~dp0jarvis-node-supervisor.mjs"`,
    'if exist "%JARVIS_NODE_STOP%" exit /b 0',
    ":cleanup_orphan",
    'if exist "%JARVIS_NODE_STOP%" exit /b 0',
    `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0jarvis-node-stop.ps1" -RuntimeRoot "%~dp0."`,
    'if exist "%JARVIS_NODE_STOP%" exit /b 0',
    "if errorlevel 1 goto cleanup_retry",
    "timeout /t 5 /nobreak >nul",
    "goto run_supervisor",
    ":cleanup_retry",
    "timeout /t 5 /nobreak >nul",
    "goto cleanup_orphan",
    "",
  ].join("\r\n");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Rendered for diagnostics and future COM-based registration. The installer
 * currently uses schtasks /Create because it works without an elevation prompt. */
export function renderWindowsTaskCreateCommand(launcherPath: string): string {
  return `schtasks.exe /Create /TN "${WINDOWS_SETUP_TASK_NAME}" /SC ONLOGON /TR "${launcherPath}" /RL LIMITED /F`;
}

export function renderWindowsTaskXml(input: {
  readonly launcherPath: string;
  readonly nodePath: string;
}): string {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>",
    '  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
    "  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>",
    `  <Actions Context="Author"><Exec><Command>${xmlEscape(input.launcherPath)}</Command><Arguments></Arguments><WorkingDirectory>${xmlEscape(NodePath.dirname(input.nodePath))}</WorkingDirectory></Exec></Actions>`,
    "</Task>",
    "",
  ].join("\r\n");
}

function nsiQuote(value: string): string {
  // NSIS uses `$\"` (not a C-style backslash) for an embedded quote.
  return `"${value.replaceAll('"', '$\\"')}"`;
}

function windowsPath(value: string): string {
  return value.replaceAll("/", "\\");
}

/**
 * Generate a self-contained NSIS source. Each payload archive is compiled into
 * the installer and extracted only by its selected section; Headless never
 * leaves the UI or speech payload on disk.
 */
export function renderWindowsSetupNsi(input: {
  readonly version: string;
  readonly arch: WindowsSetupArch;
  readonly outputPath: string;
  readonly stageRoot: string;
  readonly sevenZipPath: string;
  readonly iconPath?: string;
}): string {
  assertVersion(input.version);
  assertWindowsSetupArch(input.arch);
  const numericFileVersion = `${input.version.split(/[-+]/u, 1)[0]}.0`;
  const stage = (name: string) => `${windowsPath(input.stageRoot)}\\${name}`;
  const desktopArchive = stage("desktop.7z");
  const runtimeArchive = stage("runtime-win.7z");
  const runtimeStopPs1 = stage("runtime-win\\jarvis-node-stop.ps1");
  const ownedProcessStopPs1 = stage("jarvis-owned-process-stop.ps1");
  const ownedProcessStopCommand = `"$OwnedProcessPowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\\jarvis-owned-process-stop.ps1" -DesktopPath "$INSTDIR\\desktop\\Jarvis.exe" -CompanionPath "$INSTDIR\\companion\\Jarvis Companion.exe" $OwnedProcessLegacyArgument`;
  const stopHeadlessNodeFunction = [
    "Function StopHeadlessNode",
    "  ClearErrors",
    '  StrCpy $StopHelperAvailable "0"',
    '  StrCpy $StopFailed "0"',
    '  CreateDirectory "$PROFILE\\.jarvis\\runtime"',
    '  FileOpen $0 "$PROFILE\\.jarvis\\runtime\\windows-stop.marker" w',
    "  FileClose $0",
    "  Sleep 1500",
    '  IfFileExists "$PLUGINSDIR\\jarvis-node-stop.ps1" stop_headless_plugin_helper stop_headless_installed_helper',
    "stop_headless_plugin_helper:",
    '  StrCpy $StopHelperAvailable "1"',
    '  StrCpy $StopHelperPath "$PLUGINSDIR\\jarvis-node-stop.ps1"',
    "  Goto stop_headless_helper_attempt",
    "stop_headless_installed_helper:",
    '  IfFileExists "$INSTDIR\\runtime-win\\jarvis-node-stop.ps1" 0 stop_headless_helper_end',
    '  StrCpy $StopHelperAvailable "1"',
    '  StrCpy $StopHelperPath "$INSTDIR\\runtime-win\\jarvis-node-stop.ps1"',
    "stop_headless_helper_attempt:",
    `  nsExec::ExecToLog ${nsiQuote('$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$StopHelperPath" -RuntimeRoot "$INSTDIR\\runtime-win"')}`,
    "  Pop $R9",
    "stop_headless_helper_end:",
    `  nsExec::ExecToLog ${nsiQuote('$SYSDIR\\schtasks.exe /End /TN "Jarvis Headless Node"')}`,
    "  Pop $R9",
    '  StrCmp $StopHelperAvailable "1" stop_headless_helper_second stop_headless_task_delete',
    "stop_headless_helper_second:",
    `  nsExec::ExecToLog ${nsiQuote('$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$StopHelperPath" -RuntimeRoot "$INSTDIR\\runtime-win"')}`,
    "  Pop $R9",
    '  StrCmp $R9 "0" stop_headless_task_delete stop_headless_helper_failed',
    "stop_headless_helper_failed:",
    '  StrCpy $StopFailed "1"',
    "stop_headless_task_delete:",
    `  nsExec::ExecToLog ${nsiQuote('$SYSDIR\\schtasks.exe /Delete /TN "Jarvis Headless Node" /F')}`,
    "  Pop $R9",
    '  StrCpy $R8 "0"',
    "stop_headless_task_query:",
    `  nsExec::ExecToLog ${nsiQuote('$SYSDIR\\schtasks.exe /Query /TN "Jarvis Headless Node"')}`,
    "  Pop $R9",
    '  StrCmp $R9 "0" stop_headless_task_query_retry stop_headless_result',
    "stop_headless_task_query_retry:",
    "  IntOp $R8 $R8 + 1",
    '  StrCmp $R8 "50" stop_headless_task_query_failed 0',
    "  Sleep 100",
    "  Goto stop_headless_task_query",
    "stop_headless_task_query_failed:",
    '  StrCpy $StopFailed "1"',
    "stop_headless_result:",
    '  StrCmp $StopFailed "0" stop_headless_done stop_headless_failed',
    "stop_headless_failed:",
    "  SetErrors",
    "stop_headless_done:",
    "  Return",
    "FunctionEnd",
    "",
  ];
  const uninstallStopHeadlessNodeFunction = stopHeadlessNodeFunction.map((line) =>
    line
      .replace("Function StopHeadlessNode", "Function un.StopHeadlessNode")
      .replaceAll("stop_headless_", "un.stop_headless_"),
  );
  const stopOwnedJarvisProcessesFunction = [
    "Function StopOwnedJarvisProcesses",
    "  ClearErrors",
    '  StrCpy $OwnedProcessPowerShellPath "$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"',
    '  IfFileExists "$WINDIR\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe" 0 +2',
    '  StrCpy $OwnedProcessPowerShellPath "$WINDIR\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe"',
    '  IfFileExists "$PLUGINSDIR\\jarvis-owned-process-stop.ps1" stop_owned_helper_ready stop_owned_helper_missing',
    "stop_owned_helper_ready:",
    '  StrCmp $LegacyCompanionExecutable "" stop_owned_without_legacy stop_owned_with_legacy',
    "stop_owned_with_legacy:",
    '  StrCpy $OwnedProcessLegacyArgument " -LegacyCompanionPath $\\\"$LegacyCompanionExecutable$\\\""',
    "  Goto stop_owned_invoke",
    "stop_owned_without_legacy:",
    '  StrCpy $OwnedProcessLegacyArgument ""',
    "stop_owned_invoke:",
    `  nsExec::ExecToStack ${nsiQuote(ownedProcessStopCommand)}`,
    "  Pop $R9",
    "  Pop $R8",
    '  StrCmp $R9 "0" stop_owned_success stop_owned_failed',
    "stop_owned_failed:",
    '  FileOpen $0 "$TEMP\\jarvis-owned-process-stop-diagnostic.txt" w',
    '  FileWrite $0 "exit=$R9$\\r$\\noutput=$R8$\\r$\\n"',
    "  FileClose $0",
    '  DetailPrint "Owned process helper failed: exit=$R9 output=$R8"',
    "  SetErrors",
    "  Goto stop_owned_done",
    "stop_owned_helper_missing:",
    '  FileOpen $0 "$TEMP\\jarvis-owned-process-stop-diagnostic.txt" w',
    '  FileWrite $0 "missing=$PLUGINSDIR\\jarvis-owned-process-stop.ps1$\\r$\\n"',
    "  FileClose $0",
    '  DetailPrint "Owned process helper missing: $PLUGINSDIR\\jarvis-owned-process-stop.ps1"',
    "  SetErrors",
    "  Goto stop_owned_done",
    "stop_owned_success:",
    '  Delete "$TEMP\\jarvis-owned-process-stop-diagnostic.txt"',
    "stop_owned_done:",
    "  Return",
    "FunctionEnd",
    "",
  ];
  const uninstallStopOwnedJarvisProcessesFunction = stopOwnedJarvisProcessesFunction.map((line) =>
    line
      .replace("Function StopOwnedJarvisProcesses", "Function un.StopOwnedJarvisProcesses")
      .replaceAll("stop_owned_", "un.stop_owned_"),
  );
  return [
    "Unicode true",
    "SetCompress off",
    ...(input.iconPath ? [`!define MUI_ICON ${nsiQuote(windowsPath(input.iconPath))}`] : []),
    '!define MUI_WELCOMEPAGE_TITLE "Welcome to Jarvis Setup"',
    '!define MUI_WELCOMEPAGE_TEXT "Install Jarvis as a Full, Controller, or Headless node on this Windows device."',
    "!define MUI_FINISHPAGE_RUN",
    "!define MUI_FINISHPAGE_RUN_FUNCTION LaunchSelectedProduct",
    '!define MUI_FINISHPAGE_RUN_TEXT "Launch Jarvis"',
    '!include "MUI2.nsh"',
    '!include "LogicLib.nsh"',
    '!include "nsDialogs.nsh"',
    '!include "FileFunc.nsh"',
    `Name "Jarvis ${input.version}"`,
    `OutFile ${nsiQuote(input.outputPath)}`,
    `BrandingText "Jarvis ${input.version}"`,
    'InstallDir "$LOCALAPPDATA\\Programs\\Jarvis"',
    'InstallDirRegKey HKCU "Software\\Jarvis" "InstallLocation"',
    "RequestExecutionLevel user",
    `VIProductVersion "${numericFileVersion}"`,
    `VIAddVersionKey /LANG=1033 "ProductName" "Jarvis"`,
    `VIAddVersionKey /LANG=1033 "ProductVersion" "${input.version}"`,
    `VIAddVersionKey /LANG=1033 "FileDescription" "Jarvis Node setup"`,
    "!define MUI_ABORTWARNING",
    "Var NodeMode",
    "Var ExistingMode",
    "Var ModeFromCli",
    "Var FullRadio",
    "Var ControllerRadio",
    "Var HeadlessRadio",
    "Var ModePageHandle",
    "Var PreviousHeadless",
    "Var PreviousManifestMoved",
    "Var PreviousDesktopMoved",
    "Var PreviousRuntimeMoved",
    "Var NewManifestMoved",
    "Var NewDesktopMoved",
    "Var NewRuntimeMoved",
    "Var RestoreFailed",
    "Var LegacyCompanionExecutable",
    "Var OwnedProcessLegacyArgument",
    "Var LegacyCompanionMigrationFailed",
    "Var StopHelperAvailable",
    "Var StopHelperPath",
    "Var StopFailed",
    "Var OwnedProcessPowerShellPath",
    "!insertmacro MUI_PAGE_WELCOME",
    "!insertmacro MUI_PAGE_DIRECTORY",
    "Page custom ModePageCreate ModePageLeave",
    "!insertmacro MUI_PAGE_INSTFILES",
    "!insertmacro MUI_PAGE_FINISH",
    "!insertmacro MUI_UNPAGE_CONFIRM",
    "!insertmacro MUI_UNPAGE_INSTFILES",
    "!insertmacro MUI_UNPAGE_FINISH",
    '!insertmacro MUI_LANGUAGE "English"',
    "",
    "Function .onInit",
    '  StrCpy $NodeMode ""',
    '  StrCpy $ExistingMode ""',
    '  StrCpy $ModeFromCli ""',
    '  StrCpy $PreviousHeadless "0"',
    '  StrCpy $PreviousManifestMoved "0"',
    '  StrCpy $PreviousDesktopMoved "0"',
    '  StrCpy $PreviousRuntimeMoved "0"',
    '  StrCpy $NewManifestMoved "0"',
    '  StrCpy $NewDesktopMoved "0"',
    '  StrCpy $NewRuntimeMoved "0"',
    '  StrCpy $RestoreFailed "0"',
    '  StrCpy $LegacyCompanionExecutable ""',
    '  StrCpy $LegacyCompanionMigrationFailed "0"',
    "  ${GetParameters} $0",
    '  ${GetOptions} $0 "/MODE=" $1',
    "  IfErrors mode_from_existing 0",
    "  StrCpy $NodeMode $1",
    '  StrCpy $ModeFromCli "1"',
    "  Goto mode_validate",
    "mode_from_existing:",
    '  ReadINIStr $ExistingMode "$PROFILE\\.jarvis\\config\\preset.ini" Jarvis Preset',
    "  StrCpy $NodeMode $ExistingMode",
    "mode_validate:",
    '  StrCmp $NodeMode "" 0 mode_validate_value',
    '  StrCpy $NodeMode "full"',
    "mode_validate_value:",
    '  StrCmp $NodeMode "full" mode_valid 0',
    '  StrCmp $NodeMode "controller" mode_valid 0',
    '  StrCmp $NodeMode "headless" mode_valid 0',
    '  StrCmp $ModeFromCli "1" mode_invalid_cli 0',
    '  StrCpy $NodeMode "full"',
    "  Goto mode_valid",
    "mode_invalid_cli:",
    '  MessageBox MB_ICONSTOP "MODE must be full, controller, or headless."',
    "  Quit",
    "mode_valid:",
    "FunctionEnd",
    "",
    "Function ModePageCreate",
    "  nsDialogs::Create 1018",
    "  Pop $ModePageHandle",
    "  ${If} $ModePageHandle == error",
    "    Abort",
    "  ${EndIf}",
    '  ${NSD_CreateLabel} 0 0 100% 18u "Choose how this Windows device runs Jarvis"',
    "  Pop $0",
    '  ${NSD_CreateRadioButton} 0 30u 100% 16u "Full Node - UI, voice, and local execution"',
    "  Pop $FullRadio",
    '  ${NSD_CreateRadioButton} 0 52u 100% 16u "Controller Node - UI and voice, no local execution"',
    "  Pop $ControllerRadio",
    '  ${NSD_CreateRadioButton} 0 74u 100% 16u "Headless Node - background execution, no UI or voice"',
    "  Pop $HeadlessRadio",
    '  ${If} $NodeMode == "controller"',
    "    ${NSD_Check} $ControllerRadio",
    '  ${ElseIf} $NodeMode == "headless"',
    "    ${NSD_Check} $HeadlessRadio",
    "  ${Else}",
    "    ${NSD_Check} $FullRadio",
    "  ${EndIf}",
    "  ${NSD_OnClick} $FullRadio ModeFullClicked",
    "  ${NSD_OnClick} $ControllerRadio ModeControllerClicked",
    "  ${NSD_OnClick} $HeadlessRadio ModeHeadlessClicked",
    "  nsDialogs::Show",
    "FunctionEnd",
    "Function ModeFullClicked",
    '  StrCpy $NodeMode "full"',
    "FunctionEnd",
    "Function ModeControllerClicked",
    '  StrCpy $NodeMode "controller"',
    "FunctionEnd",
    "Function ModeHeadlessClicked",
    '  StrCpy $NodeMode "headless"',
    "FunctionEnd",
    "Function ModePageLeave",
    '  StrCmp $NodeMode "full" 0 +3',
    '  StrCpy $0 "full"',
    "  Goto mode_valid",
    '  StrCmp $NodeMode "controller" 0 +3',
    '  StrCpy $0 "controller"',
    "  Goto mode_valid",
    '  StrCmp $NodeMode "headless" 0 mode_invalid',
    '  StrCpy $0 "headless"',
    "mode_valid:",
    "  StrCpy $NodeMode $0",
    "  Return",
    "mode_invalid:",
    '  MessageBox MB_ICONSTOP "Choose Full, Controller, or Headless Node."',
    "  Abort",
    "FunctionEnd",
    "",
    'Section "-Owned process shutdown helper" SEC_OWNED_PROCESS_HELPER',
    "  InitPluginsDir",
    '  SetOutPath "$PLUGINSDIR"',
    `  File /oname=jarvis-owned-process-stop.ps1 ${nsiQuote(ownedProcessStopPs1)}`,
    "SectionEnd",
    "",
    ...stopOwnedJarvisProcessesFunction,
    ...uninstallStopOwnedJarvisProcessesFunction,
    "",
    "Function MigrateLegacyCompanion",
    `  ReadRegStr $R0 HKCU "${LEGACY_COMPANION_UNINSTALL_REGISTRY_KEY}" "UninstallString"`,
    '  StrCmp $R0 "" legacy_companion_migration_done 0',
    '  StrCpy $LegacyCompanionMigrationFailed "1"',
    `  ReadRegStr $R1 HKCU "${LEGACY_COMPANION_INSTALL_REGISTRY_KEY}" "InstallLocation"`,
    '  StrCmp $R1 "" legacy_companion_migration_done 0',
    '  IfFileExists "$R1\\Jarvis Companion.exe" 0 legacy_companion_migration_done',
    '  IfFileExists "$R1\\Uninstall Jarvis Companion.exe" 0 legacy_companion_migration_done',
    '  StrCpy $LegacyCompanionExecutable "$R1\\Jarvis Companion.exe"',
    "  Call StopOwnedJarvisProcesses",
    "  IfErrors legacy_companion_migration_done 0",
    `  ExecWait '"$R1\\Uninstall Jarvis Companion.exe" /S' $R2`,
    '  StrCmp $R2 "0" legacy_companion_migration_success legacy_companion_migration_done',
    "legacy_companion_migration_success:",
    '  StrCpy $LegacyCompanionMigrationFailed "0"',
    "legacy_companion_migration_done:",
    "FunctionEnd",
    "",
    "Function LaunchSelectedProduct",
    '  StrCmp $NodeMode "headless" launch_selected_done 0',
    '  Exec "$INSTDIR\\desktop\\Jarvis.exe"',
    "  Goto launch_selected_done",
    "launch_selected_done:",
    "FunctionEnd",
    "",
    ...stopHeadlessNodeFunction,
    ...uninstallStopHeadlessNodeFunction,
    'Section "-Headless shutdown helper" SEC_SHUTDOWN_HELPER',
    '  SetOutPath "$PLUGINSDIR"',
    `  File /oname=$PLUGINSDIR\\jarvis-node-stop.ps1 ${nsiQuote(runtimeStopPs1)}`,
    "SectionEnd",
    "",
    'Section "Reset old mode" SEC_RESET',
    "  ; Payloads are extracted under .incoming first; active payloads survive an extraction failure.",
    "  IfSilent apps_close apps_prompt",
    "apps_prompt:",
    '  MessageBox MB_ICONEXCLAMATION|MB_OKCANCEL "Close Jarvis before continuing. The installer will request it to exit." IDOK apps_close IDCANCEL apps_abort',
    "apps_abort:",
    "  Abort",
    "apps_close:",
    "  Call StopOwnedJarvisProcesses",
    "  IfErrors owned_process_stop_abort 0",
    "  Call MigrateLegacyCompanion",
    '  StrCmp $LegacyCompanionMigrationFailed "1" legacy_companion_migration_abort 0',
    '  CreateDirectory "$PROFILE\\.jarvis\\runtime"',
    '  ReadINIStr $ExistingMode "$PROFILE\\.jarvis\\config\\preset.ini" Jarvis Preset',
    '  StrCmp $ExistingMode "headless" 0 previous_mode_checked',
    '  StrCpy $PreviousHeadless "1"',
    "previous_mode_checked:",
    "  ClearErrors",
    "  Call StopHeadlessNode",
    "  IfErrors reset_stop_failed 0",
    '  RMDir /r "$INSTDIR\\.incoming"',
    "  Goto reset_stop_done",
    "legacy_companion_migration_abort:",
    '  MessageBox MB_ICONSTOP "Previous Companion install could not be removed safely. Close it and try again."',
    "  Abort",
    "owned_process_stop_abort:",
    "  IfSilent owned_process_stop_silent owned_process_stop_interactive",
    "owned_process_stop_silent:",
    "  SetErrorLevel 6",
    "  Quit",
    "owned_process_stop_interactive:",
    '  MessageBox MB_ICONSTOP "Jarvis could not stop its existing processes safely. Close Jarvis and try again."',
    "  Abort",
    "reset_stop_failed:",
    "  IfSilent reset_stop_silent reset_stop_interactive",
    "reset_stop_silent:",
    "  SetErrorLevel 5",
    "  Quit",
    "reset_stop_interactive:",
    '  MessageBox MB_ICONSTOP "Jarvis could not stop the existing headless runtime. Your installation was left in place."',
    "  Abort",
    "reset_stop_done:",
    "SectionEnd",
    "",
    "  ; The embedded checksum-pinned 7za.exe returns an explicit status; marker and entrypoint validation below catches partial output.",
    'Section "-Embedded extractor" SEC_EXTRACTOR',
    '  SetOutPath "$PLUGINSDIR"',
    `  File /oname=$PLUGINSDIR\\7za.exe ${nsiQuote(input.sevenZipPath)}`,
    "SectionEnd",
    "",
    'Section "Desktop payload" SEC_DESKTOP',
    '  StrCmp $NodeMode "headless" desktop_done',
    "  Push $OUTDIR",
    `  File /oname=$PLUGINSDIR\\desktop.7z ${nsiQuote(desktopArchive)}`,
    '  SetOutPath "$INSTDIR\\.incoming\\desktop"',
    `  nsExec::ExecToLog ${nsiQuote('"$PLUGINSDIR\\7za.exe" x -y -aoa -bb0 -bd -o"$INSTDIR\\.incoming\\desktop" "$PLUGINSDIR\\desktop.7z"')}`,
    "  Pop $R1",
    '  Delete "$PLUGINSDIR\\desktop.7z"',
    "  Pop $R0",
    "  SetOutPath $R0",
    '  StrCmp $R1 "0" desktop_extract_done desktop_extract_failed',
    "desktop_extract_failed:",
    "  Call HandleStagingFailure",
    "  Abort",
    "desktop_extract_done:",
    "desktop_done:",
    "SectionEnd",
    "",
    'Section "Windows runtime payload" SEC_RUNTIME',
    '  StrCmp $NodeMode "headless" runtime_extract',
    "  Goto runtime_done",
    "runtime_extract:",
    "  Push $OUTDIR",
    `  File /oname=$PLUGINSDIR\\runtime-win.7z ${nsiQuote(runtimeArchive)}`,
    '  SetOutPath "$INSTDIR\\.incoming\\runtime-win"',
    `  nsExec::ExecToLog ${nsiQuote('"$PLUGINSDIR\\7za.exe" x -y -aoa -bb0 -bd -o"$INSTDIR\\.incoming\\runtime-win" "$PLUGINSDIR\\runtime-win.7z"')}`,
    "  Pop $R1",
    '  Delete "$PLUGINSDIR\\runtime-win.7z"',
    "  Pop $R0",
    "  SetOutPath $R0",
    '  StrCmp $R1 "0" runtime_extract_done runtime_extract_failed',
    "runtime_extract_failed:",
    "  Call HandleStagingFailure",
    "  Abort",
    "runtime_extract_done:",
    "runtime_done:",
    "SectionEnd",
    "",
    'Section "Persist node mode" SEC_STATE',
    "  ; Commit the fully extracted payload set only after all File operations succeeded.",
    '  SetOutPath "$INSTDIR\\.incoming"',
    `  File /oname=payload-manifest.json ${nsiQuote(`${windowsPath(input.stageRoot)}\\manifest.json`)}`,
    "  Call ValidateStagedPayload",
    "  ; Move the old payload aside only after validation. If any incoming rename fails,",
    "  ; RestorePreviousPayload puts that complete old payload back before aborting.",
    '  RMDir /r "$INSTDIR\\.previous"',
    '  CreateDirectory "$INSTDIR\\.previous"',
    '  StrCpy $PreviousManifestMoved "0"',
    '  StrCpy $PreviousDesktopMoved "0"',
    '  StrCpy $PreviousRuntimeMoved "0"',
    '  StrCpy $NewManifestMoved "0"',
    '  StrCpy $NewDesktopMoved "0"',
    '  StrCpy $NewRuntimeMoved "0"',
    "  ; Stage every existing payload, not only the selected mode. This removes",
    "  ; stale UI/voice files on a Full/Controller -> Headless upgrade and stale",
    "  ; runtime files on the reverse transition.",
    '  IfFileExists "$INSTDIR\\payload-manifest.json" 0 backup_manifest_done',
    "  ClearErrors",
    '  Rename "$INSTDIR\\payload-manifest.json" "$INSTDIR\\.previous\\payload-manifest.json"',
    "  IfErrors staged_commit_failed 0",
    '  StrCpy $PreviousManifestMoved "1"',
    "backup_manifest_done:",
    '  IfFileExists "$INSTDIR\\desktop" 0 backup_desktop_done',
    "  ClearErrors",
    '  Rename "$INSTDIR\\desktop" "$INSTDIR\\.previous\\desktop"',
    "  IfErrors staged_commit_failed 0",
    '  StrCpy $PreviousDesktopMoved "1"',
    "backup_desktop_done:",
    '  IfFileExists "$INSTDIR\\runtime-win" 0 commit_selected_payload',
    "  ClearErrors",
    '  Rename "$INSTDIR\\runtime-win" "$INSTDIR\\.previous\\runtime-win"',
    "  IfErrors staged_commit_failed 0",
    '  StrCpy $PreviousRuntimeMoved "1"',
    "commit_selected_payload:",
    '  StrCmp $NodeMode "headless" commit_runtime commit_gui',
    "commit_runtime:",
    "  ClearErrors",
    '  Rename "$INSTDIR\\.incoming\\runtime-win" "$INSTDIR\\runtime-win"',
    "  IfErrors staged_commit_failed 0",
    '  StrCpy $NewRuntimeMoved "1"',
    "  Goto payload_committed",
    "commit_gui:",
    "  ClearErrors",
    '  Rename "$INSTDIR\\.incoming\\desktop" "$INSTDIR\\desktop"',
    "  IfErrors staged_commit_failed 0",
    '  StrCpy $NewDesktopMoved "1"',
    "payload_committed:",
    "  ClearErrors",
    '  Rename "$INSTDIR\\.incoming\\payload-manifest.json" "$INSTDIR\\payload-manifest.json"',
    "  IfErrors staged_commit_failed 0",
    '  StrCpy $NewManifestMoved "1"',
    '  RMDir /r "$INSTDIR\\.incoming"',
    '  RMDir /r "$INSTDIR\\.previous"',
    '  CreateDirectory "$PROFILE\\.jarvis\\config"',
    '  CreateDirectory "$PROFILE\\.jarvis\\runtime"',
    '  WriteINIStr "$PROFILE\\.jarvis\\config\\preset.ini" Jarvis Preset $NodeMode',
    '  FileOpen $0 "$PROFILE\\.jarvis\\config\\node-preset.json" w',
    // The NSIS string delimiters are the ordinary quotes immediately around
    // the JSON object. `$\\"` is only used for JSON's inner quotes; using it
    // around the whole object would persist an invalid quoted JSON string.
    '  FileWrite $0 "{$\\"product$\\":$\\"Jarvis$\\",$\\"preset$\\":$\\"$NodeMode$\\",$\\"nodeType$\\":$\\"$NodeMode$\\"}$\\r$\\n"',
    "  FileClose $0",
    '  WriteRegStr HKCU "Software\\Jarvis" "InstallLocation" "$INSTDIR"',
    '  WriteRegStr HKCU "Software\\Jarvis" "Preset" "$NodeMode"',
    `  WriteRegStr HKCU "${WINDOWS_SETUP_UNINSTALL_REGISTRY_KEY}" "DisplayName" "Jarvis"`,
    `  WriteRegStr HKCU "${WINDOWS_SETUP_UNINSTALL_REGISTRY_KEY}" "DisplayVersion" "${input.version}"`,
    `  WriteRegStr HKCU "${WINDOWS_SETUP_UNINSTALL_REGISTRY_KEY}" "Publisher" "Abstergo"`,
    '  StrCmp $NodeMode "headless" 0 registry_gui',
    '  StrCpy $0 "$INSTDIR\\runtime-win\\node\\node.exe"',
    "  Goto registry_icon_ready",
    "registry_gui:",
    '  StrCpy $0 "$INSTDIR\\desktop\\Jarvis.exe"',
    "registry_icon_ready:",
    `  WriteRegStr HKCU "${WINDOWS_SETUP_UNINSTALL_REGISTRY_KEY}" "DisplayIcon" "$0"`,
    `  WriteRegStr HKCU "${WINDOWS_SETUP_UNINSTALL_REGISTRY_KEY}" "UninstallString" "$\\"$INSTDIR\\Uninstall Jarvis.exe$\\""`,
    `  WriteRegStr HKCU "${WINDOWS_SETUP_UNINSTALL_REGISTRY_KEY}" "QuietUninstallString" "$\\"$INSTDIR\\Uninstall Jarvis.exe$\\" /S"`,
    `  WriteRegDWORD HKCU "${WINDOWS_SETUP_UNINSTALL_REGISTRY_KEY}" "NoModify" 1`,
    `  WriteRegDWORD HKCU "${WINDOWS_SETUP_UNINSTALL_REGISTRY_KEY}" "NoRepair" 1`,
    '  WriteUninstaller "$INSTDIR\\Uninstall Jarvis.exe"',
    '  StrCmp $NodeMode "headless" 0 state_gui',
    '  FileOpen $0 "$PROFILE\\.jarvis\\runtime\\windows-stop.marker" w',
    "  FileClose $0",
    '  Delete "$PROFILE\\.jarvis\\runtime\\windows-stop.marker"',
    `  nsExec::ExecToLog ${nsiQuote(renderWindowsTaskCreateCommand("$INSTDIR\\runtime-win\\jarvis-node-launcher.cmd"))}`,
    "  Pop $R9",
    `  nsExec::ExecToLog ${nsiQuote('$SYSDIR\\schtasks.exe /Run /TN "Jarvis Headless Node"')}`,
    "  Pop $R9",
    "  Goto state_done",
    "state_gui:",
    '  Delete "$PROFILE\\.jarvis\\runtime\\windows-stop.marker"',
    '  CreateDirectory "$SMPROGRAMS\\Jarvis"',
    `  CreateShortCut "$DESKTOP\\Jarvis.lnk" "$INSTDIR\\desktop\\Jarvis.exe"`,
    `  CreateShortCut "$SMPROGRAMS\\Jarvis\\Jarvis.lnk" "$INSTDIR\\desktop\\Jarvis.exe"`,
    "  Goto state_done",
    "staged_commit_failed:",
    "  Call RestorePreviousPayload",
    "state_done:",
    "SectionEnd",
    "",
    "Function HandleStagingFailure",
    '  RMDir /r "$INSTDIR\\.incoming"',
    '  Delete "$PROFILE\\.jarvis\\runtime\\windows-stop.marker"',
    '  StrCmp $PreviousHeadless "1" 0 staging_failure_message',
    `  nsExec::ExecToLog ${nsiQuote(renderWindowsTaskCreateCommand("$INSTDIR\\runtime-win\\jarvis-node-launcher.cmd"))}`,
    "  Pop $R9",
    `  nsExec::ExecToLog ${nsiQuote('$SYSDIR\\schtasks.exe /Run /TN "Jarvis Headless Node"')}`,
    "  Pop $R9",
    "staging_failure_message:",
    "  IfSilent staging_failure_silent staging_failure_interactive",
    "staging_failure_silent:",
    "  SetErrorLevel 2",
    "  Quit",
    "staging_failure_interactive:",
    '  MessageBox MB_ICONSTOP "Jarvis could not validate the staged payload. Your existing installation was left in place."',
    "  Abort",
    "FunctionEnd",
    "",
    "Function ValidateStagedPayload",
    "  ; Never remove the active payload until the selected incoming set and manifest are present.",
    '  IfFileExists "$INSTDIR\\.incoming\\payload-manifest.json" +2 0',
    "  Goto staged_payload_invalid",
    '  StrCmp $NodeMode "headless" 0 staged_payload_controller_or_full',
    '  IfFileExists "$INSTDIR\\.incoming\\runtime-win\\jarvis-payload-complete.txt" 0 staged_payload_invalid',
    '  IfFileExists "$INSTDIR\\.incoming\\runtime-win\\node\\node.exe" 0 staged_payload_invalid',
    '  IfFileExists "$INSTDIR\\.incoming\\runtime-win\\dist\\bin.mjs" 0 staged_payload_invalid',
    '  IfFileExists "$INSTDIR\\.incoming\\runtime-win\\jarvis-node-supervisor.mjs" 0 staged_payload_invalid',
    '  IfFileExists "$INSTDIR\\.incoming\\runtime-win\\jarvis-node-stop.ps1" 0 staged_payload_invalid',
    '  IfFileExists "$INSTDIR\\.incoming\\runtime-win\\jarvis-node-launcher.cmd" staged_payload_valid staged_payload_invalid',
    "  Goto staged_payload_invalid",
    "staged_payload_controller_or_full:",
    '  IfFileExists "$INSTDIR\\.incoming\\desktop\\jarvis-payload-complete.txt" 0 staged_payload_invalid',
    '  IfFileExists "$INSTDIR\\.incoming\\desktop\\Jarvis.exe" 0 staged_payload_invalid',
    "  Goto staged_payload_valid",
    "staged_payload_valid:",
    "  Return",
    "staged_payload_invalid:",
    "  Call HandleStagingFailure",
    "  Abort",
    "FunctionEnd",
    "",
    "Function RestorePreviousPayload",
    '  StrCpy $RestoreFailed "0"',
    '  StrCmp $NewDesktopMoved "1" 0 restore_new_runtime',
    "  ClearErrors",
    '  RMDir /r "$INSTDIR\\desktop"',
    "  IfErrors restore_new_desktop_failed restore_new_runtime",
    "restore_new_desktop_failed:",
    '  StrCpy $RestoreFailed "1"',
    "  Goto restore_new_runtime",
    "restore_new_runtime:",
    '  StrCmp $NewRuntimeMoved "1" 0 restore_new_manifest',
    "  ClearErrors",
    '  RMDir /r "$INSTDIR\\runtime-win"',
    "  IfErrors restore_new_runtime_failed restore_new_manifest",
    "restore_new_runtime_failed:",
    '  StrCpy $RestoreFailed "1"',
    "  Goto restore_new_manifest",
    "restore_new_manifest:",
    '  StrCmp $NewManifestMoved "1" 0 restore_desktop',
    "  ClearErrors",
    '  Delete "$INSTDIR\\payload-manifest.json"',
    "  IfErrors restore_new_manifest_failed restore_desktop",
    "restore_new_manifest_failed:",
    '  StrCpy $RestoreFailed "1"',
    "  Goto restore_desktop",
    "restore_desktop:",
    '  StrCmp $PreviousDesktopMoved "1" 0 restore_runtime',
    '  IfFileExists "$INSTDIR\\.previous\\desktop" restore_desktop_move restore_desktop_missing',
    "restore_desktop_move:",
    "  ClearErrors",
    '  Rename "$INSTDIR\\.previous\\desktop" "$INSTDIR\\desktop"',
    "  IfErrors restore_desktop_rename_failed restore_runtime",
    "restore_desktop_rename_failed:",
    '  StrCpy $RestoreFailed "1"',
    "  Goto restore_runtime",
    "restore_desktop_missing:",
    '  StrCpy $RestoreFailed "1"',
    "  Goto restore_runtime",
    "restore_runtime:",
    '  StrCmp $PreviousRuntimeMoved "1" 0 restore_manifest',
    '  IfFileExists "$INSTDIR\\.previous\\runtime-win" restore_runtime_move restore_runtime_missing',
    "restore_runtime_move:",
    "  ClearErrors",
    '  Rename "$INSTDIR\\.previous\\runtime-win" "$INSTDIR\\runtime-win"',
    "  IfErrors restore_runtime_rename_failed restore_manifest",
    "restore_runtime_rename_failed:",
    '  StrCpy $RestoreFailed "1"',
    "  Goto restore_manifest",
    "restore_runtime_missing:",
    '  StrCpy $RestoreFailed "1"',
    "  Goto restore_manifest",
    "restore_manifest:",
    '  StrCmp $PreviousManifestMoved "1" 0 restore_decision',
    '  IfFileExists "$INSTDIR\\.previous\\payload-manifest.json" restore_manifest_move restore_manifest_missing',
    "restore_manifest_move:",
    "  ClearErrors",
    '  Rename "$INSTDIR\\.previous\\payload-manifest.json" "$INSTDIR\\payload-manifest.json"',
    "  IfErrors restore_manifest_rename_failed restore_decision",
    "restore_manifest_rename_failed:",
    '  StrCpy $RestoreFailed "1"',
    "  Goto restore_decision",
    "restore_manifest_missing:",
    '  StrCpy $RestoreFailed "1"',
    "  Goto restore_decision",
    "restore_decision:",
    '  StrCmp $RestoreFailed "0" restore_task restore_failed',
    "restore_task:",
    '  StrCmp $PreviousHeadless "1" 0 restore_manifest_done',
    '  Delete "$PROFILE\\.jarvis\\runtime\\windows-stop.marker"',
    `  nsExec::ExecToLog ${nsiQuote(renderWindowsTaskCreateCommand("$INSTDIR\\runtime-win\\jarvis-node-launcher.cmd"))}`,
    "  Pop $R9",
    '  StrCmp $R9 "0" restore_task_run restore_task_failed',
    "restore_task_run:",
    `  nsExec::ExecToLog ${nsiQuote('$SYSDIR\\schtasks.exe /Run /TN "Jarvis Headless Node"')}`,
    "  Pop $R9",
    '  StrCmp $R9 "0" restore_task_complete restore_task_failed',
    "restore_task_complete:",
    "  Goto restore_cleanup",
    "restore_task_failed:",
    '  StrCpy $RestoreFailed "1"',
    "  Goto restore_failed",
    "restore_manifest_done:",
    "restore_cleanup:",
    '  RMDir /r "$INSTDIR\\.previous"',
    '  RMDir /r "$INSTDIR\\.incoming"',
    "  IfSilent restore_silent restore_interactive",
    "restore_silent:",
    "  SetErrorLevel 3",
    "  Quit",
    "restore_interactive:",
    '  MessageBox MB_ICONSTOP "Jarvis could not commit the staged payload. Your existing installation was restored."',
    "  Abort",
    "restore_failed:",
    '  RMDir /r "$INSTDIR\\.incoming"',
    "  IfSilent restore_failed_silent restore_failed_interactive",
    "restore_failed_silent:",
    "  SetErrorLevel 4",
    "  Quit",
    "restore_failed_interactive:",
    '  MessageBox MB_ICONSTOP "Jarvis could not fully roll back the staged payload. Recovery files, if present, remain at $INSTDIR\\.previous."',
    "  Abort",
    "FunctionEnd",
    "",
    'Section "Uninstall"',
    "  InitPluginsDir",
    '  SetOutPath "$PLUGINSDIR"',
    `  File /oname=jarvis-owned-process-stop.ps1 ${nsiQuote(ownedProcessStopPs1)}`,
    "  Call un.StopOwnedJarvisProcesses",
    "  IfErrors un_owned_process_stop_failed 0",
    "  ClearErrors",
    "  Call un.StopHeadlessNode",
    "  IfErrors un_stop_headless_failed 0",
    '  Delete "$PROFILE\\.jarvis\\runtime\\windows-stop.marker"',
    "  Goto un_stop_headless_done",
    "un_stop_headless_failed:",
    "  IfSilent un_stop_headless_silent un_stop_headless_interactive",
    "un_stop_headless_silent:",
    "  SetErrorLevel 5",
    "  Quit",
    "un_stop_headless_interactive:",
    '  MessageBox MB_ICONSTOP "Jarvis could not stop the headless runtime. The installation was left in place."',
    "  Abort",
    "un_owned_process_stop_failed:",
    "  IfSilent un_owned_process_stop_silent un_owned_process_stop_interactive",
    "un_owned_process_stop_silent:",
    "  SetErrorLevel 6",
    "  Quit",
    "un_owned_process_stop_interactive:",
    '  MessageBox MB_ICONSTOP "Jarvis could not stop its processes safely. The installation was left in place."',
    "  Abort",
    "un_stop_headless_done:",
    '  Delete "$DESKTOP\\Jarvis.lnk"',
    '  Delete "$SMPROGRAMS\\Jarvis\\Jarvis.lnk"',
    '  RMDir "$SMPROGRAMS\\Jarvis"',
    '  DeleteRegKey HKCU "Software\\Jarvis"',
    `  DeleteRegKey HKCU "${WINDOWS_SETUP_UNINSTALL_REGISTRY_KEY}"`,
    '  RMDir /r "$INSTDIR"',
    "  ; Deliberately preserve $PROFILE\\.jarvis: projects, providers, reports, and credentials.",
    "SectionEnd",
    "",
  ].join("\r\n");
}

export async function writeWindowsSetupManifest(
  path: string,
  manifest: WindowsSetupManifest,
): Promise<void> {
  await NodeFSP.writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function writeWindowsSetupProvenance(
  path: string,
  provenance: WindowsSetupProvenance,
): Promise<void> {
  await NodeFSP.writeFile(path, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
}
