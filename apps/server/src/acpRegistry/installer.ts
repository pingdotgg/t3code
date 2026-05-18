// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  AcpRegistryError,
  type AcpRegistryBinaryPlatform,
  type AcpRegistryBinaryTarget,
  type AcpRegistryDistributionKind,
  type AcpRegistryEntry,
  type AcpRegistryInstallState,
  type AcpRegistryPackageDistribution,
} from "@t3tools/contracts";

import { resolveCurrentPlatform } from "./platform.ts";

type FetchLike = (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>;

export interface SpawnTarget {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly cwd: string | undefined;
  readonly distribution: AcpRegistryDistributionKind;
}

export interface InstallContext {
  readonly cacheRoot: string;
  readonly platform?: AcpRegistryBinaryPlatform | undefined;
  readonly fetchImpl?: FetchLike;
}

export interface InstallResult {
  readonly state: AcpRegistryInstallState;
}

type ArchiveKind = "tar-gz" | "tar-bz2" | "tar" | "zip" | "raw";

const ARCHIVE_FILENAME: Record<ArchiveKind, string> = {
  "tar-gz": "archive.tar.gz",
  "tar-bz2": "archive.tar.bz2",
  tar: "archive.tar",
  zip: "archive.zip",
  raw: "agent.bin",
};

const ARCHIVE_DETECTORS: ReadonlyArray<readonly [RegExp, ArchiveKind]> = [
  [/\.(tar\.gz|tgz)$/, "tar-gz"],
  [/\.(tar\.bz2|tbz2)$/, "tar-bz2"],
  [/\.tar$/, "tar"],
  [/\.zip$/, "zip"],
];

const WINDOWS_ABS_PATH = /^[a-zA-Z]:[/\\]/;

export function availableChannels(
  entry: AcpRegistryEntry,
  platform: AcpRegistryBinaryPlatform | undefined = resolveCurrentPlatform(),
): ReadonlyArray<AcpRegistryDistributionKind> {
  const channels: AcpRegistryDistributionKind[] = [];
  const binaryTarget = platform ? entry.distribution.binary?.[platform] : undefined;
  if (binaryTarget) channels.push("binary");
  if (entry.distribution.npx) channels.push("npx");
  if (entry.distribution.uvx) channels.push("uvx");
  return channels;
}

export async function installAgent(
  entry: AcpRegistryEntry,
  context: InstallContext,
): Promise<InstallResult> {
  const platform = context.platform ?? resolveCurrentPlatform();
  const channels = availableChannels(entry, platform);
  const distribution = channels[0];

  if (!distribution) {
    throw new AcpRegistryError({
      agentId: entry.id,
      detail: `No supported distribution for platform ${platform ?? "unknown"}.`,
    });
  }

  if (distribution !== "binary") {
    return { state: makeInstallState(entry, distribution) };
  }

  const target = platform && entry.distribution.binary?.[platform];
  if (!target) {
    throw new AcpRegistryError({
      agentId: entry.id,
      detail: `No binary target for platform ${platform ?? "unknown"}.`,
    });
  }

  const binaryPath = await installBinary(entry, target, context);
  return { state: makeInstallState(entry, "binary", binaryPath) };
}

export async function uninstallAgent(entry: AcpRegistryEntry, cacheRoot: string): Promise<void> {
  await fsPromises.rm(path.join(cacheRoot, safePathSegment(entry.id, "agent id", entry.id)), {
    recursive: true,
    force: true,
  });
}

export function resolveSpawnTarget(
  entry: AcpRegistryEntry,
  installState: AcpRegistryInstallState | undefined,
  options: { readonly cwd?: string } = {},
): SpawnTarget | undefined {
  if (!installState) return undefined;

  switch (installState.distribution) {
    case "binary": {
      if (!installState.binaryPath) return undefined;
      const platform = resolveCurrentPlatform();
      const target = platform ? entry.distribution.binary?.[platform] : undefined;
      return {
        command: installState.binaryPath,
        args: target?.args ? [...target.args] : [],
        env: target?.env as NodeJS.ProcessEnv | undefined,
        cwd: options.cwd,
        distribution: "binary",
      };
    }
    case "npx":
      return packageSpawn(entry.distribution.npx, "npx", options.cwd);
    case "uvx":
      return packageSpawn(entry.distribution.uvx, "uvx", options.cwd);
  }
}

async function installBinary(
  entry: AcpRegistryEntry,
  target: AcpRegistryBinaryTarget,
  context: InstallContext,
): Promise<string> {
  const installRoot = path.join(
    context.cacheRoot,
    safePathSegment(entry.id, "agent id", entry.id),
    safePathSegment(entry.version, "agent version", entry.id),
  );
  const archiveKind = detectArchiveKind(target.archive);
  const archivePath = path.join(installRoot, ARCHIVE_FILENAME[archiveKind]);

  await fsPromises.rm(installRoot, { recursive: true, force: true });
  await fsPromises.mkdir(installRoot, { recursive: true });

  await downloadToFile(target.archive, archivePath, context.fetchImpl ?? globalThis.fetch);
  if (target.sha256) {
    await verifySha256(archivePath, target.sha256, entry.id);
  }
  await extractArchive(archivePath, archiveKind, installRoot, target.cmd, entry.id);

  const binaryPath = resolveCmdPath(installRoot, target.cmd, entry.id);
  if (archivePath !== binaryPath) {
    await fsPromises.rm(archivePath, { force: true });
  }
  await fsPromises.chmod(binaryPath, 0o755).catch(() => undefined);
  return binaryPath;
}

function makeInstallState(
  entry: AcpRegistryEntry,
  distribution: AcpRegistryDistributionKind,
  binaryPath?: string,
): AcpRegistryInstallState {
  return {
    version: entry.version,
    installedAt: new Date().toISOString(),
    distribution,
    ...(binaryPath ? { binaryPath } : {}),
  };
}

function detectArchiveKind(url: string): ArchiveKind {
  const urlPath = url.toLowerCase().split("?")[0] ?? "";
  for (const [pattern, kind] of ARCHIVE_DETECTORS) {
    if (pattern.test(urlPath)) return kind;
  }
  return "raw";
}

function safePathSegment(value: string, label: string, agentId: string): string {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    WINDOWS_ABS_PATH.test(value)
  ) {
    throw new AcpRegistryError({
      agentId,
      detail: `Invalid ACP registry ${label}: ${value}`,
    });
  }
  return value;
}

function assertInsideRoot(root: string, targetPath: string, agentId: string, detail: string): void {
  const relative = path.relative(root, targetPath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new AcpRegistryError({ agentId, detail });
}

function resolveCmdPath(installRoot: string, cmd: string, agentId: string): string {
  if (path.isAbsolute(cmd) || WINDOWS_ABS_PATH.test(cmd)) {
    throw new AcpRegistryError({
      agentId,
      detail: `ACP registry command path must be relative to the install root: ${cmd}`,
    });
  }
  const targetPath = path.resolve(installRoot, cmd.replace(/^\.[/\\]/, ""));
  assertInsideRoot(
    installRoot,
    targetPath,
    agentId,
    `ACP registry command path escapes the install root: ${cmd}`,
  );
  return targetPath;
}

async function verifySha256(
  filePath: string,
  expectedSha256: string,
  agentId: string,
): Promise<void> {
  const normalizedExpected = expectedSha256.trim().toLowerCase();
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }
  const actual = digest.digest("hex");
  if (actual !== normalizedExpected) {
    throw new AcpRegistryError({
      agentId,
      detail: `Checksum mismatch for downloaded archive: expected ${normalizedExpected}, got ${actual}`,
    });
  }
}

async function downloadToFile(url: string, destPath: string, fetchImpl: FetchLike): Promise<void> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new AcpRegistryError({
      detail: `Download failed (${response.status} ${response.statusText}) — ${url}`,
    });
  }
  if (!response.body) {
    throw new AcpRegistryError({ detail: `Download returned an empty body — ${url}` });
  }
  const readable = Readable.fromWeb(response.body as unknown as ReadableStream<Uint8Array>);
  await pipeline(readable, createWriteStream(destPath));
}

async function extractArchive(
  archivePath: string,
  archiveKind: ArchiveKind,
  installRoot: string,
  cmd: string,
  agentId: string,
): Promise<void> {
  switch (archiveKind) {
    case "tar-gz":
      await assertSafeArchiveEntries(archivePath, archiveKind, installRoot, agentId);
      return runProcess("tar", ["-xzf", archivePath], installRoot);
    case "tar-bz2":
      await assertSafeArchiveEntries(archivePath, archiveKind, installRoot, agentId);
      return runProcess("tar", ["-xjf", archivePath], installRoot);
    case "tar":
      await assertSafeArchiveEntries(archivePath, archiveKind, installRoot, agentId);
      return runProcess("tar", ["-xf", archivePath], installRoot);
    case "zip":
      await assertSafeArchiveEntries(archivePath, archiveKind, installRoot, agentId);
      return extractZip(archivePath, installRoot);
    case "raw":
      {
        const binaryPath = resolveCmdPath(installRoot, cmd, agentId);
        await fsPromises.mkdir(path.dirname(binaryPath), { recursive: true });
        if (archivePath !== binaryPath) {
          await fsPromises.copyFile(archivePath, binaryPath);
        }
      }
      return;
  }
}

async function assertSafeArchiveEntries(
  archivePath: string,
  archiveKind: Exclude<ArchiveKind, "raw">,
  installRoot: string,
  agentId: string,
): Promise<void> {
  const listing =
    archiveKind === "zip"
      ? await listZipEntries(archivePath, installRoot)
      : await runProcessCapture("tar", ["-tf", archivePath], installRoot);
  for (const entry of listing.split(/\r?\n/)) {
    if (!entry) continue;
    const normalized = entry.replace(/\\/g, "/");
    if (
      normalized.startsWith("/") ||
      normalized.includes("\0") ||
      WINDOWS_ABS_PATH.test(normalized)
    ) {
      throw new AcpRegistryError({
        agentId,
        detail: `Archive entry is not relative to the install root: ${entry}`,
      });
    }
    assertInsideRoot(
      installRoot,
      path.resolve(installRoot, normalized),
      agentId,
      `Archive entry escapes the install root: ${entry}`,
    );
  }
}

function listZipEntries(archivePath: string, cwd: string): Promise<string> {
  if (process.platform === "win32") {
    return runProcessCapture(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
          "$zip = [System.IO.Compression.ZipFile]::OpenRead($args[0]); " +
          "try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }",
        archivePath,
      ],
      cwd,
    );
  }
  return runProcessCapture("unzip", ["-Z1", archivePath], cwd);
}

function extractZip(archivePath: string, installRoot: string): Promise<void> {
  if (process.platform === "win32") {
    return runProcess(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
        archivePath,
        installRoot,
      ],
      installRoot,
    );
  }
  return runProcess("unzip", ["-q", "-o", archivePath, "-d", installRoot], installRoot);
}

function runProcess(command: string, args: ReadonlyArray<string>, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (cause) =>
      reject(
        new AcpRegistryError({
          detail: `Failed to run ${command}: ${cause.message}`,
          cause,
        }),
      ),
    );
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const trimmed = stderr.trim();
      reject(
        new AcpRegistryError({
          detail: `${command} ${args.join(" ")} exited with ${code ?? "signal"}${
            trimmed ? ` — ${trimmed}` : ""
          }`,
        }),
      );
    });
  });
}

function runProcessCapture(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (cause) =>
      reject(
        new AcpRegistryError({
          detail: `Failed to run ${command}: ${cause.message}`,
          cause,
        }),
      ),
    );
    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const trimmed = stderr.trim();
      reject(
        new AcpRegistryError({
          detail: `${command} ${args.join(" ")} exited with ${code ?? "signal"}${
            trimmed ? ` — ${trimmed}` : ""
          }`,
        }),
      );
    });
  });
}

let cachedBunxAvailable: boolean | undefined;

function bunxAvailable(): boolean {
  if (cachedBunxAvailable !== undefined) return cachedBunxAvailable;
  cachedBunxAvailable = checkOnPath("bunx");
  return cachedBunxAvailable;
}

function checkOnPath(command: string): boolean {
  const finder = process.platform === "win32" ? "where" : "which";
  return spawnSync(finder, [command], { stdio: "ignore" }).status === 0;
}

function packageSpawn(
  pkg: AcpRegistryPackageDistribution | undefined,
  channel: "npx" | "uvx",
  cwd: string | undefined,
): SpawnTarget | undefined {
  if (!pkg) return undefined;
  const command = channel === "uvx" ? "uvx" : bunxAvailable() ? "bunx" : "npx";
  return {
    command,
    args: [pkg.package, ...(pkg.args ?? [])],
    env: pkg.env as NodeJS.ProcessEnv | undefined,
    cwd,
    distribution: channel,
  };
}
