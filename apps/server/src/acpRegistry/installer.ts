// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import {
  AcpRegistryError,
  type AcpRegistryBinaryPlatform,
  type AcpRegistryBinaryTarget,
  type AcpRegistryDistributionKind,
  type AcpRegistryEntry,
  type AcpRegistryInstallState,
  type AcpRegistryPackageDistribution,
} from "@t3tools/contracts";

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
  readonly platform: AcpRegistryBinaryPlatform | undefined;
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
  platform: AcpRegistryBinaryPlatform | undefined,
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
  const platform = context.platform;
  const channels = availableChannels(entry, platform);
  const distribution = channels[0];

  if (!distribution) {
    throw new AcpRegistryError({
      operation: "resolve-distribution",
      agentId: entry.id,
      detail: "No supported distribution is available for this platform.",
      platform: platform ?? "unknown",
    });
  }

  if (distribution !== "binary") {
    return { state: makeInstallState(entry, distribution) };
  }

  const target = platform && entry.distribution.binary?.[platform];
  if (!target) {
    throw new AcpRegistryError({
      operation: "resolve-binary-target",
      agentId: entry.id,
      detail: "No binary target is available for this platform.",
      platform: platform ?? "unknown",
    });
  }

  const binaryPath = await installBinary(entry, target, context);
  return { state: makeInstallState(entry, "binary", binaryPath) };
}

export async function uninstallAgent(entry: AcpRegistryEntry, cacheRoot: string): Promise<void> {
  await NodeFSP.rm(NodePath.join(cacheRoot, safePathSegment(entry.id, "agent id", entry.id)), {
    recursive: true,
    force: true,
  });
}

export function resolveSpawnTarget(
  entry: AcpRegistryEntry,
  installState: AcpRegistryInstallState | undefined,
  options: {
    readonly cwd?: string;
    readonly platform?: AcpRegistryBinaryPlatform | undefined;
  } = {},
): SpawnTarget | undefined {
  if (!installState) return undefined;

  switch (installState.distribution) {
    case "binary": {
      if (!installState.binaryPath) return undefined;
      const platform = options.platform;
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
      return packageSpawn(entry.distribution.npx, "npx", options.cwd, options.platform);
    case "uvx":
      return packageSpawn(entry.distribution.uvx, "uvx", options.cwd, options.platform);
  }
}

async function installBinary(
  entry: AcpRegistryEntry,
  target: AcpRegistryBinaryTarget,
  context: InstallContext,
): Promise<string> {
  const installRoot = NodePath.join(
    context.cacheRoot,
    safePathSegment(entry.id, "agent id", entry.id),
    safePathSegment(entry.version, "agent version", entry.id),
  );
  const archiveKind = detectArchiveKind(target.archive);
  const archivePath = NodePath.join(installRoot, ARCHIVE_FILENAME[archiveKind]);

  await NodeFSP.rm(installRoot, { recursive: true, force: true });
  await NodeFSP.mkdir(installRoot, { recursive: true });

  await downloadToFile(target.archive, archivePath, context.fetchImpl ?? globalThis.fetch);
  if (target.sha256) {
    await verifySha256(archivePath, target.sha256, entry.id);
  }
  await extractArchive(
    archivePath,
    archiveKind,
    installRoot,
    target.cmd,
    entry.id,
    context.platform,
  );

  const binaryPath = resolveCmdPath(installRoot, target.cmd, entry.id);
  if (archivePath !== binaryPath) {
    await NodeFSP.rm(archivePath, { force: true });
  }
  await NodeFSP.chmod(binaryPath, 0o755).catch(() => undefined);
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
      operation: "validate-install-path",
      agentId,
      detail: `Invalid ACP registry ${label}: ${value}`,
    });
  }
  return value;
}

function assertInsideRoot(root: string, targetPath: string, agentId: string, detail: string): void {
  const relative = NodePath.relative(root, targetPath);
  if (relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative))) {
    return;
  }
  throw new AcpRegistryError({ operation: "validate-install-path", agentId, detail });
}

function resolveCmdPath(installRoot: string, cmd: string, agentId: string): string {
  if (NodePath.isAbsolute(cmd) || WINDOWS_ABS_PATH.test(cmd)) {
    throw new AcpRegistryError({
      operation: "validate-install-path",
      agentId,
      detail: `ACP registry command path must be relative to the install root: ${cmd}`,
    });
  }
  const targetPath = NodePath.resolve(installRoot, cmd.replace(/^\.[/\\]/, ""));
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
  const digest = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(filePath)) {
    digest.update(chunk);
  }
  const actual = digest.digest("hex");
  if (actual !== normalizedExpected) {
    throw new AcpRegistryError({
      operation: "verify-download",
      agentId,
      detail: "The downloaded archive checksum did not match.",
      expectedChecksum: normalizedExpected,
      actualChecksum: actual,
    });
  }
}

async function downloadToFile(url: string, destPath: string, fetchImpl: FetchLike): Promise<void> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new AcpRegistryError({
      operation: "download",
      detail: "The registry archive download failed.",
      url,
      status: response.status,
      statusText: response.statusText,
    });
  }
  if (!response.body) {
    throw new AcpRegistryError({
      operation: "download",
      detail: "The registry archive download returned an empty body.",
      url,
    });
  }
  const readable = NodeStream.Readable.fromWeb(
    response.body as unknown as ReadableStream<Uint8Array>,
  );
  await NodeStreamPromises.pipeline(readable, NodeFS.createWriteStream(destPath));
}

async function extractArchive(
  archivePath: string,
  archiveKind: ArchiveKind,
  installRoot: string,
  cmd: string,
  agentId: string,
  platform: AcpRegistryBinaryPlatform | undefined,
): Promise<void> {
  switch (archiveKind) {
    case "tar-gz":
      await assertSafeArchiveEntries(archivePath, archiveKind, installRoot, agentId, platform);
      return runProcess("tar", ["-xzf", archivePath], installRoot);
    case "tar-bz2":
      await assertSafeArchiveEntries(archivePath, archiveKind, installRoot, agentId, platform);
      return runProcess("tar", ["-xjf", archivePath], installRoot);
    case "tar":
      await assertSafeArchiveEntries(archivePath, archiveKind, installRoot, agentId, platform);
      return runProcess("tar", ["-xf", archivePath], installRoot);
    case "zip":
      await assertSafeArchiveEntries(archivePath, archiveKind, installRoot, agentId, platform);
      return extractZip(archivePath, installRoot, platform);
    case "raw":
      {
        const binaryPath = resolveCmdPath(installRoot, cmd, agentId);
        await NodeFSP.mkdir(NodePath.dirname(binaryPath), { recursive: true });
        if (archivePath !== binaryPath) {
          await NodeFSP.copyFile(archivePath, binaryPath);
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
  platform: AcpRegistryBinaryPlatform | undefined,
): Promise<void> {
  const listing =
    archiveKind === "zip"
      ? await listZipEntries(archivePath, installRoot, platform)
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
        operation: "validate-archive",
        agentId,
        detail: "An archive entry is not relative to the install root.",
        path: entry,
      });
    }
    assertInsideRoot(
      installRoot,
      NodePath.resolve(installRoot, normalized),
      agentId,
      `Archive entry escapes the install root: ${entry}`,
    );
  }
}

function listZipEntries(
  archivePath: string,
  cwd: string,
  platform: AcpRegistryBinaryPlatform | undefined,
): Promise<string> {
  if (platform?.startsWith("windows-") === true) {
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

function extractZip(
  archivePath: string,
  installRoot: string,
  platform: AcpRegistryBinaryPlatform | undefined,
): Promise<void> {
  if (platform?.startsWith("windows-") === true) {
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
    const child = NodeChildProcess.spawn(command, [...args], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (cause) =>
      reject(
        new AcpRegistryError({
          operation: "run-process",
          detail: "Failed to start an installer command.",
          command,
          args: [...args],
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
          operation: "run-process",
          detail: "An installer command exited unsuccessfully.",
          command,
          args: [...args],
          exitCode: code,
          ...(trimmed ? { stderr: trimmed } : {}),
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
    const child = NodeChildProcess.spawn(command, [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
          operation: "run-process",
          detail: "Failed to start an installer command.",
          command,
          args: [...args],
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
          operation: "run-process",
          detail: "An installer command exited unsuccessfully.",
          command,
          args: [...args],
          exitCode: code,
          ...(trimmed ? { stderr: trimmed } : {}),
        }),
      );
    });
  });
}

let cachedBunxAvailable: boolean | undefined;

function bunxAvailable(platform: AcpRegistryBinaryPlatform | undefined): boolean {
  if (cachedBunxAvailable !== undefined) return cachedBunxAvailable;
  cachedBunxAvailable = checkOnPath("bunx", platform);
  return cachedBunxAvailable;
}

function checkOnPath(command: string, platform: AcpRegistryBinaryPlatform | undefined): boolean {
  const finder = platform?.startsWith("windows-") === true ? "where" : "which";
  return NodeChildProcess.spawnSync(finder, [command], { stdio: "ignore" }).status === 0;
}

function packageSpawn(
  pkg: AcpRegistryPackageDistribution | undefined,
  channel: "npx" | "uvx",
  cwd: string | undefined,
  platform: AcpRegistryBinaryPlatform | undefined,
): SpawnTarget | undefined {
  if (!pkg) return undefined;
  const command = channel === "uvx" ? "uvx" : bunxAvailable(platform) ? "bunx" : "npx";
  return {
    command,
    args: [pkg.package, ...(pkg.args ?? [])],
    env: pkg.env as NodeJS.ProcessEnv | undefined,
    cwd,
    distribution: channel,
  };
}
