// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off globalRandom:off extendsNativeError:off - Plain-TypeScript game bridge core (sockets, files, vendor HTTP), unit-tested without an Effect runtime; GameDevService wraps it.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { GameCheckpoint, GameCheckpointChange, GameEngineId } from "@t3tools/contracts";
import { CHECKPOINT_DEFAULT_PATHS, CHECKPOINT_EXCLUDED_DIRS } from "@t3tools/shared/gameDevCatalog";
import { createTwoFilesPatch } from "diff";

import { exists, listDir, sha256File, writeJsonAtomic } from "./gameDevFiles.ts";

/**
 * Game Project Checkpoints: a copy of the files a risky change could touch (scenes, assets,
 * scripts, settings) that the user can diff against and restore. Roblox places also store a
 * snapshot of scripts and properties taken through the Studio bridge.
 */

const MAX_TOTAL_BYTES = 2 * 1024 ** 3;
const MAX_FILES = 50_000;
const MAX_DIFF_BYTES = 256 * 1024;

interface Manifest extends GameCheckpoint {
  readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: number; readonly sha256: string }>;
}

export function checkpointsDir(baseDir: string, projectRoot: string): string {
  const key = NodeCrypto.createHash("sha256").update(NodePath.resolve(projectRoot)).digest("hex").slice(0, 16);
  return NodePath.join(baseDir, "game-checkpoints", key);
}

function toRelative(root: string, full: string): string {
  return NodePath.relative(root, full).split(NodePath.sep).join("/");
}

async function coveredFiles(projectRoot: string, covers: ReadonlyArray<string>): Promise<{ files: string[]; skipped: string[] }> {
  const files: string[] = [];
  const skipped: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await listDir(dir)) {
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (CHECKPOINT_EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        if (files.length >= MAX_FILES) {
          skipped.push(toRelative(projectRoot, full));
          continue;
        }
        files.push(full);
      }
    }
  };
  for (const cover of covers) {
    if (cover.includes("*")) {
      const pattern = new RegExp(`^${cover.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      for (const entry of await listDir(projectRoot)) {
        if (entry.isFile() && pattern.test(entry.name)) files.push(NodePath.join(projectRoot, entry.name));
      }
      continue;
    }
    const full = NodePath.resolve(projectRoot, cover);
    if (!full.startsWith(NodePath.resolve(projectRoot))) continue;
    const stat = await NodeFSP.stat(full).catch(() => null);
    if (stat?.isDirectory()) await walk(full);
    else if (stat?.isFile()) files.push(full);
  }
  return { files: [...new Set(files)], skipped };
}

export async function createCheckpoint(input: {
  readonly baseDir: string;
  readonly projectRoot: string;
  readonly engine: GameEngineId;
  readonly label: string;
  readonly paths: ReadonlyArray<string> | undefined;
  readonly createdBy: "agent" | "user";
  readonly robloxSnapshot: unknown;
  readonly now: Date;
}): Promise<GameCheckpoint> {
  const covers = input.paths && input.paths.length > 0 ? input.paths : CHECKPOINT_DEFAULT_PATHS[input.engine];
  const checkpointId = `cp_${input.now.getTime().toString(36)}${NodeCrypto.randomBytes(3).toString("hex")}`;
  const dir = NodePath.join(checkpointsDir(input.baseDir, input.projectRoot), checkpointId);
  const { files, skipped } = await coveredFiles(input.projectRoot, covers);
  const records: Array<{ path: string; bytes: number; sha256: string }> = [];
  let totalBytes = 0;
  for (const file of files) {
    const stat = await NodeFSP.stat(file);
    const relative = toRelative(input.projectRoot, file);
    if (totalBytes + stat.size > MAX_TOTAL_BYTES) {
      skipped.push(relative);
      continue;
    }
    const destination = NodePath.join(dir, "files", relative);
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.copyFile(file, destination);
    records.push({ path: relative, bytes: stat.size, sha256: await sha256File(file) });
    totalBytes += stat.size;
  }
  const instances = countSnapshot(input.robloxSnapshot);
  const manifest: Manifest = {
    checkpointId,
    projectRoot: input.projectRoot,
    engine: input.engine,
    label: input.label.trim() || "Checkpoint",
    createdAt: input.now.toISOString(),
    createdBy: input.createdBy,
    covers: [...covers, ...(instances > 0 ? ["Roblox scripts and part, GUI, and value properties in the open place"] : [])],
    fileCount: records.length,
    totalBytes,
    instanceCount: instances,
    skipped: skipped.slice(0, 200),
    files: records,
  };
  if (input.robloxSnapshot !== null && input.robloxSnapshot !== undefined) {
    await writeJsonAtomic(NodePath.join(dir, "roblox-snapshot.json"), input.robloxSnapshot);
  }
  await writeJsonAtomic(NodePath.join(dir, "manifest.json"), manifest);
  return withoutFiles(manifest);
}

function countSnapshot(snapshot: unknown): number {
  if (typeof snapshot !== "object" || snapshot === null) return 0;
  const { scripts, instances } = snapshot as { scripts?: unknown[]; instances?: unknown[] };
  return (Array.isArray(scripts) ? scripts.length : 0) + (Array.isArray(instances) ? instances.length : 0);
}

function withoutFiles(manifest: Manifest): GameCheckpoint {
  const { files: _files, ...checkpoint } = manifest;
  return checkpoint;
}

async function readManifest(baseDir: string, projectRoot: string, checkpointId: string): Promise<Manifest> {
  if (!/^cp_[a-z0-9]+$/.test(checkpointId)) throw new Error("Unknown checkpoint.");
  const path = NodePath.join(checkpointsDir(baseDir, projectRoot), checkpointId, "manifest.json");
  const text = await NodeFSP.readFile(path, "utf8").catch(() => null);
  if (text === null) throw new Error("Unknown checkpoint.");
  return JSON.parse(text) as Manifest;
}

export async function listCheckpoints(baseDir: string, projectRoot: string): Promise<GameCheckpoint[]> {
  const dir = checkpointsDir(baseDir, projectRoot);
  const checkpoints: GameCheckpoint[] = [];
  for (const entry of await listDir(dir)) {
    if (!entry.isDirectory()) continue;
    const manifest = await readManifest(baseDir, projectRoot, entry.name).catch(() => null);
    if (manifest) checkpoints.push(withoutFiles(manifest));
  }
  return checkpoints.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function readRobloxSnapshot(baseDir: string, projectRoot: string, checkpointId: string): Promise<unknown> {
  await readManifest(baseDir, projectRoot, checkpointId);
  const path = NodePath.join(checkpointsDir(baseDir, projectRoot), checkpointId, "roblox-snapshot.json");
  const text = await NodeFSP.readFile(path, "utf8").catch(() => null);
  return text === null ? null : JSON.parse(text);
}

function looksText(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8000).includes(0);
}

export async function diffCheckpoint(baseDir: string, projectRoot: string, checkpointId: string) {
  const manifest = await readManifest(baseDir, projectRoot, checkpointId);
  const stored = NodePath.join(checkpointsDir(baseDir, projectRoot), checkpointId, "files");
  const { files } = await coveredFiles(projectRoot, manifest.covers.filter((cover) => !cover.startsWith("Roblox ")));
  const current = new Map(files.map((file) => [toRelative(projectRoot, file), file]));
  const changes: GameCheckpointChange[] = [];
  for (const record of manifest.files) {
    const now = current.get(record.path);
    current.delete(record.path);
    if (now === undefined) {
      changes.push({ path: record.path, change: "deleted", diff: null });
      continue;
    }
    if ((await sha256File(now)) === record.sha256) continue;
    changes.push({ path: record.path, change: "modified", diff: await textDiff(record.path, NodePath.join(stored, record.path), now) });
  }
  for (const [path, full] of current) {
    changes.push({ path, change: "added", diff: await textDiff(path, null, full) });
  }
  changes.sort((left, right) => left.path.localeCompare(right.path));
  return { checkpoint: withoutFiles(manifest), changes };
}

async function textDiff(path: string, before: string | null, after: string | null): Promise<string | null> {
  const read = async (file: string | null) => (file === null ? Buffer.alloc(0) : await NodeFSP.readFile(file));
  const [a, b] = await Promise.all([read(before), read(after)]);
  if (a.length > MAX_DIFF_BYTES || b.length > MAX_DIFF_BYTES || !looksText(a) || !looksText(b)) return null;
  return createTwoFilesPatch(`checkpoint/${path}`, `current/${path}`, a.toString("utf8"), b.toString("utf8"), "", "", { context: 3 });
}

/** Puts covered files back as they were and removes files added under the covered folders. */
export async function restoreCheckpoint(baseDir: string, projectRoot: string, checkpointId: string) {
  const before = await diffCheckpoint(baseDir, projectRoot, checkpointId);
  const stored = NodePath.join(checkpointsDir(baseDir, projectRoot), checkpointId, "files");
  for (const change of before.changes) {
    const target = NodePath.resolve(projectRoot, change.path);
    if (!target.startsWith(NodePath.resolve(projectRoot))) continue;
    if (change.change === "added") {
      await NodeFSP.rm(target, { force: true });
    } else {
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.copyFile(NodePath.join(stored, change.path), target);
    }
  }
  return before;
}

export async function checkpointExists(baseDir: string, projectRoot: string, checkpointId: string): Promise<boolean> {
  return exists(NodePath.join(checkpointsDir(baseDir, projectRoot), checkpointId, "manifest.json"));
}
