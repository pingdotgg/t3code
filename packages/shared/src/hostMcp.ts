// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalRandom:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  HostMcpAdvertisement,
  type DesktopBootstrapMcpServer,
  type DesktopBootstrapWorkspaceFolder,
} from "@t3tools/contracts";
import {
  readAdvertisementFilenames,
  readAdvertisementJson,
  sanitizeAdvertisementId,
  writeAdvertisementJson,
} from "./advertisementFiles.ts";
import { hasActiveWorkspaceFolder, workspaceFoldersIncludeRoot } from "./workspaceFolders.ts";

export const HOST_MCP_ADVERTISEMENT_TTL_MS = 30_000;
export const HOST_MCP_ADVERTISEMENT_HEARTBEAT_MS = 10_000;
export const HOST_MCP_ADVERTISEMENT_CLEANUP_GRACE_MS = 15 * 60_000;
export const HOST_MCP_ADVERTISEMENT_CLEANUP_MAX_DELETES = 25;

const ADVERTISEMENT_DIR_PARTS = ["host-mcp", "advertisements"] as const;
const HOST_ID_PATTERN = /^[a-zA-Z0-9._-]+$/u;

export interface CreateHostMcpAdvertisementInput {
  readonly hostId: string;
  readonly nowMs?: number;
  readonly ttlMs?: number;
  readonly mcpServer: DesktopBootstrapMcpServer;
  readonly workspaceFolders: readonly DesktopBootstrapWorkspaceFolder[];
  readonly activeWorkspaceFolderKey?: string | undefined;
}

export interface ReadHostMcpAdvertisementsInput {
  readonly t3Home: string;
  readonly nowMs?: number;
  readonly workspaceRoot?: string | undefined;
}

export interface HostMcpAdvertisementReadResult {
  readonly advertisements: readonly HostMcpAdvertisement[];
  readonly malformed: number;
}

export interface CleanupHostMcpAdvertisementsInput {
  readonly t3Home: string;
  readonly nowMs?: number;
  readonly graceMs?: number;
  readonly maxDeletes?: number;
}

export interface CleanupHostMcpAdvertisementsResult {
  readonly deleted: number;
  readonly errors: number;
}

const decodeHostMcpAdvertisement = Schema.decodeUnknownSync(HostMcpAdvertisement);

export function resolveHostMcpAdvertisementDir(t3Home: string): string {
  return NodePath.join(t3Home, ...ADVERTISEMENT_DIR_PARTS);
}

export function resolveHostMcpAdvertisementPath(t3Home: string, hostId: string): string {
  return NodePath.join(resolveHostMcpAdvertisementDir(t3Home), `${sanitizeHostId(hostId)}.json`);
}

export function createHostMcpAdvertisement(
  input: CreateHostMcpAdvertisementInput,
): HostMcpAdvertisement {
  const nowMs = input.nowMs ?? Date.now();
  const expiresAtMs = nowMs + (input.ttlMs ?? HOST_MCP_ADVERTISEMENT_TTL_MS);
  return {
    version: 1,
    hostId: sanitizeHostId(input.hostId),
    hostKind: "vscode",
    updatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    mcpServer: input.mcpServer,
    workspaceFolders: [...input.workspaceFolders],
    ...(input.activeWorkspaceFolderKey
      ? { activeWorkspaceFolderKey: input.activeWorkspaceFolderKey }
      : {}),
  };
}

export function writeHostMcpAdvertisement(input: {
  readonly t3Home: string;
  readonly advertisement: HostMcpAdvertisement;
}): void {
  const dir = resolveHostMcpAdvertisementDir(input.t3Home);
  const targetPath = resolveHostMcpAdvertisementPath(input.t3Home, input.advertisement.hostId);
  writeAdvertisementJson({
    dir,
    targetPath,
    id: input.advertisement.hostId,
    value: input.advertisement,
  });
}

export function removeHostMcpAdvertisement(input: {
  readonly t3Home: string;
  readonly hostId: string;
}): void {
  NodeFS.rmSync(resolveHostMcpAdvertisementPath(input.t3Home, input.hostId), {
    force: true,
  });
}

export function readHostMcpAdvertisements(
  input: ReadHostMcpAdvertisementsInput,
): HostMcpAdvertisementReadResult {
  const nowMs = input.nowMs ?? Date.now();
  const dir = resolveHostMcpAdvertisementDir(input.t3Home);
  const entries = readAdvertisementFilenames(dir);
  const advertisements: HostMcpAdvertisement[] = [];
  let malformed = 0;

  for (const entry of entries) {
    const filePath = NodePath.join(dir, entry);
    const readResult = readAdvertisementJson(filePath, decodeHostMcpAdvertisement);
    if (readResult._tag !== "ok") {
      if (readResult._tag === "invalid") {
        malformed += 1;
      }
      continue;
    }
    const advertisement = readResult.value;

    if (isExpired(advertisement, nowMs)) {
      continue;
    }
    const workspaceRoot = input.workspaceRoot;
    if (workspaceRoot) {
      if (!workspaceFoldersIncludeRoot(advertisement.workspaceFolders, workspaceRoot)) {
        continue;
      }
    }
    advertisements.push(advertisement);
  }

  return {
    advertisements: advertisements.toSorted(compareHostMcpAdvertisements),
    malformed,
  };
}

export function cleanupHostMcpAdvertisements(
  input: CleanupHostMcpAdvertisementsInput,
): CleanupHostMcpAdvertisementsResult {
  const nowMs = input.nowMs ?? Date.now();
  const graceMs = input.graceMs ?? HOST_MCP_ADVERTISEMENT_CLEANUP_GRACE_MS;
  const maxDeletes = input.maxDeletes ?? HOST_MCP_ADVERTISEMENT_CLEANUP_MAX_DELETES;
  const dir = resolveHostMcpAdvertisementDir(input.t3Home);
  const entries = readAdvertisementFilenames(dir);
  let deleted = 0;
  let errors = 0;

  for (const entry of entries) {
    if (deleted >= maxDeletes) {
      break;
    }
    const filePath = NodePath.join(dir, entry);
    const readResult = readAdvertisementJson(filePath, decodeHostMcpAdvertisement);
    if (readResult._tag !== "ok") {
      continue;
    }
    const advertisement = readResult.value;
    const expiresAtMs = Date.parse(advertisement.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs + graceMs > nowMs) {
      continue;
    }
    try {
      NodeFS.rmSync(filePath, { force: true });
      deleted += 1;
    } catch {
      errors += 1;
    }
  }

  return { deleted, errors };
}

export function mergeHostMcpServers(
  bootstrapServers: readonly DesktopBootstrapMcpServer[],
  discoveredServers: readonly DesktopBootstrapMcpServer[],
): readonly DesktopBootstrapMcpServer[] {
  const seenNames = new Set<string>();
  const merged: DesktopBootstrapMcpServer[] = [];
  for (const server of [...bootstrapServers, ...discoveredServers]) {
    if (seenNames.has(server.name)) {
      continue;
    }
    seenNames.add(server.name);
    merged.push(server);
  }
  return merged;
}

export function workspaceRootsMatch(left: string, right: string): boolean {
  return workspaceFoldersIncludeRoot([{ cwd: left }], right);
}

function sanitizeHostId(hostId: string): string {
  return sanitizeAdvertisementId({
    id: hostId,
    pattern: HOST_ID_PATTERN,
    label: "Host MCP advertisement hostId",
  });
}

function isExpired(advertisement: HostMcpAdvertisement, nowMs: number): boolean {
  const expiresAtMs = Date.parse(advertisement.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}

function compareHostMcpAdvertisements(
  left: HostMcpAdvertisement,
  right: HostMcpAdvertisement,
): number {
  const activeLeft = hasActiveWorkspaceFolder(left);
  const activeRight = hasActiveWorkspaceFolder(right);
  if (activeLeft !== activeRight) {
    return activeLeft ? -1 : 1;
  }
  return left.hostId.localeCompare(right.hostId);
}
