import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";

export const VIRTUAL_WORKSPACE_METADATA_FILE = ".t3-virtual-workspace.json";
/** Number of inactive days before a cache-owned virtual checkout becomes pruneable. */
export const VIRTUAL_WORKSPACE_RETENTION_DAYS = 15;
/** Minimum number of most-recently-used virtual checkouts retained regardless of age. */
export const VIRTUAL_WORKSPACE_MIN_RECENT_TO_KEEP = 10;

export interface GithubVirtualWorkspace {
  readonly owner: string;
  readonly repository: string;
  readonly cloneUrl: string;
}

export interface VirtualWorkspaceCacheResult {
  readonly deleted: number;
  readonly kept: number;
  readonly errors: number;
}

export interface VirtualWorkspaceCommandDependencies {
  readonly mkdirSync: typeof fs.mkdirSync;
  readonly runCommand: (command: string, args: readonly string[]) => Promise<void>;
}

interface VirtualWorkspaceMetadata {
  readonly version: 1;
  readonly provider: "github";
  readonly workspaceFolderKey: string;
  readonly cloneUrl: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly lastBackendStartedAt: string;
}

interface CacheEntry {
  readonly path: string;
  readonly metadata: VirtualWorkspaceMetadata;
  readonly lastUsedAtMs: number;
}

export function parseGithubVirtualWorkspace(
  folder: vscode.WorkspaceFolder,
): GithubVirtualWorkspace | null {
  const scheme = (folder.uri.scheme || "").toLowerCase();
  const authority = (folder.uri.authority || "").toLowerCase();
  const isGithubVirtualWorkspace =
    (scheme === "vscode-vfs" && authority === "github") ||
    (scheme.includes("github") && authority.length === 0);
  if (!isGithubVirtualWorkspace) {
    return null;
  }

  const uriPath = folder.uri.path || folder.uri.fsPath;
  const [owner, repository] = uriPath.split("/").filter(Boolean);
  if (!owner || !repository) {
    return null;
  }

  return {
    owner,
    repository,
    cloneUrl: `https://github.com/${owner}/${repository}.git`,
  };
}

export async function ensureGithubVirtualWorkspaceClone(input: {
  readonly key: string;
  readonly owner: string;
  readonly repository: string;
  readonly cloneUrl: string;
  readonly t3Home: string;
  readonly dependencies: VirtualWorkspaceCommandDependencies;
  readonly outputChannel: Pick<vscode.OutputChannel, "appendLine">;
  readonly now?: Date;
}): Promise<string> {
  const checkoutDir = resolveGithubVirtualWorkspaceCheckoutPath(input);
  const now = input.now ?? new Date();
  if (fs.existsSync(path.join(checkoutDir, ".git"))) {
    input.outputChannel.appendLine(
      `[backend] Refreshing GitHub virtual workspace checkout ${input.owner}/${input.repository}: ${checkoutDir}`,
    );
    await refreshGithubVirtualWorkspaceCheckout({
      checkoutDir,
      dependencies: input.dependencies,
    });
    input.outputChannel.appendLine(
      `[backend] Using refreshed GitHub virtual workspace checkout ${input.owner}/${input.repository}: ${checkoutDir}`,
    );
    touchVirtualWorkspaceMetadata({
      checkoutDir,
      cloneUrl: input.cloneUrl,
      key: input.key,
      now,
    });
    return checkoutDir;
  }

  input.dependencies.mkdirSync(path.dirname(checkoutDir), { recursive: true });
  fs.rmSync(checkoutDir, { force: true, recursive: true });
  input.outputChannel.appendLine(
    `[backend] Cloning GitHub virtual workspace ${input.owner}/${input.repository} into ${checkoutDir}`,
  );
  try {
    await input.dependencies.runCommand("git", [
      "clone",
      "--filter=blob:none",
      input.cloneUrl,
      checkoutDir,
    ]);
    touchVirtualWorkspaceMetadata({
      checkoutDir,
      cloneUrl: input.cloneUrl,
      key: input.key,
      now,
    });
  } catch (error) {
    fs.rmSync(checkoutDir, { force: true, recursive: true });
    throw error;
  }
  return checkoutDir;
}

async function refreshGithubVirtualWorkspaceCheckout(input: {
  readonly checkoutDir: string;
  readonly dependencies: VirtualWorkspaceCommandDependencies;
}): Promise<void> {
  const git = async (args: readonly string[]) => {
    await input.dependencies.runCommand("git", ["-C", input.checkoutDir, ...args]);
  };

  await git(["fetch", "--prune", "origin"]);
  await git(["remote", "set-head", "origin", "--auto"]);
  await git(["reset", "--hard", "origin/HEAD"]);
  await git(["clean", "-ffdx"]);
}

export function resolveGithubVirtualWorkspaceCheckoutPath(input: {
  readonly key: string;
  readonly owner: string;
  readonly repository: string;
  readonly t3Home: string;
}): string {
  const ownerSegment = sanitizePathSegment(input.owner);
  const repositorySegment = sanitizePathSegment(input.repository);
  const keyHash = crypto.createHash("sha256").update(input.key).digest("hex").slice(0, 12);
  return path.join(
    input.t3Home,
    "virtual-workspaces",
    "github",
    `${ownerSegment}-${repositorySegment}-${keyHash}`,
  );
}

export function pruneVirtualWorkspaceCache(input: {
  readonly t3Home: string;
  readonly activeCheckoutPaths?: readonly string[];
  readonly now?: Date;
  readonly outputChannel?: Pick<vscode.OutputChannel, "appendLine">;
}): VirtualWorkspaceCacheResult {
  const now = input.now ?? new Date();
  const cutoffMs = now.getTime() - VIRTUAL_WORKSPACE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const activePaths = normalizePathSet(input.activeCheckoutPaths ?? []);
  const entries = readGithubCacheEntries(input.t3Home);
  const recentKeepPaths = new Set(
    entries
      .toSorted((left, right) => right.lastUsedAtMs - left.lastUsedAtMs)
      .slice(0, VIRTUAL_WORKSPACE_MIN_RECENT_TO_KEEP)
      .map((entry) => path.resolve(entry.path)),
  );
  let deleted = 0;
  let errors = 0;

  for (const entry of entries) {
    const entryPath = path.resolve(entry.path);
    if (
      activePaths.has(entryPath) ||
      recentKeepPaths.has(entryPath) ||
      entry.lastUsedAtMs >= cutoffMs
    ) {
      continue;
    }

    try {
      fs.rmSync(entry.path, { force: true, recursive: true });
      deleted += 1;
    } catch (error) {
      errors += 1;
      input.outputChannel?.appendLine(
        `[backend] Failed to prune virtual workspace checkout ${entry.path}: ${stringifyError(error)}`,
      );
    }
  }

  return { deleted, kept: entries.length - deleted - errors, errors };
}

export function cleanVirtualWorkspaceCache(input: {
  readonly t3Home: string;
  readonly activeCheckoutPaths?: readonly string[];
  readonly outputChannel?: Pick<vscode.OutputChannel, "appendLine">;
}): VirtualWorkspaceCacheResult {
  const activePaths = normalizePathSet(input.activeCheckoutPaths ?? []);
  const entries = readGithubCacheEntries(input.t3Home);
  let deleted = 0;
  let errors = 0;

  for (const entry of entries) {
    if (activePaths.has(path.resolve(entry.path))) {
      continue;
    }

    try {
      fs.rmSync(entry.path, { force: true, recursive: true });
      deleted += 1;
    } catch (error) {
      errors += 1;
      input.outputChannel?.appendLine(
        `[backend] Failed to clean virtual workspace checkout ${entry.path}: ${stringifyError(error)}`,
      );
    }
  }

  return { deleted, kept: entries.length - deleted - errors, errors };
}

function touchVirtualWorkspaceMetadata(input: {
  readonly checkoutDir: string;
  readonly key: string;
  readonly cloneUrl: string;
  readonly now: Date;
}): void {
  const existing = readMetadata(input.checkoutDir);
  const timestamp = input.now.toISOString();
  const metadata: VirtualWorkspaceMetadata = {
    version: 1,
    provider: "github",
    workspaceFolderKey: input.key,
    cloneUrl: input.cloneUrl,
    createdAt: existing?.createdAt ?? timestamp,
    lastUsedAt: timestamp,
    lastBackendStartedAt: timestamp,
  };
  fs.writeFileSync(
    path.join(input.checkoutDir, VIRTUAL_WORKSPACE_METADATA_FILE),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}

function readGithubCacheEntries(t3Home: string): CacheEntry[] {
  const parentDir = path.join(t3Home, "virtual-workspaces", "github");
  if (!fs.existsSync(parentDir)) {
    return [];
  }

  const entries: CacheEntry[] = [];
  for (const dirent of fs.readdirSync(parentDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const entryPath = path.join(parentDir, dirent.name);
    const metadata = readMetadata(entryPath);
    if (!metadata) {
      continue;
    }

    const lastUsedAtMs = Date.parse(metadata.lastUsedAt);
    if (!Number.isFinite(lastUsedAtMs)) {
      continue;
    }

    entries.push({ path: entryPath, metadata, lastUsedAtMs });
  }
  return entries;
}

function readMetadata(checkoutDir: string): VirtualWorkspaceMetadata | null {
  try {
    const raw = fs.readFileSync(path.join(checkoutDir, VIRTUAL_WORKSPACE_METADATA_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<VirtualWorkspaceMetadata>;
    if (
      parsed.version === 1 &&
      parsed.provider === "github" &&
      typeof parsed.workspaceFolderKey === "string" &&
      typeof parsed.cloneUrl === "string" &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.lastUsedAt === "string" &&
      typeof parsed.lastBackendStartedAt === "string"
    ) {
      return parsed as VirtualWorkspaceMetadata;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizePathSet(paths: readonly string[]): Set<string> {
  return new Set(paths.map((candidate) => path.resolve(candidate)));
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
