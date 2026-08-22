// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw filesystem access for transcript scanning.
 *
 * Isolated here so the rest of the usage code stays on Effect's `FileSystem`.
 * The direct `node:fs` streaming is deliberate: a cold 30-day window is ~1.4 GB
 * across ~1,500 files, and `readline` over a read stream is roughly an order of
 * magnitude cheaper than materialising each file. The equivalent Effect stream
 * pipeline is idiomatic but not fast enough to sit behind a page load.
 *
 * @module usageTranscriptReader
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type { UsageProviderKind } from "@t3tools/contracts";

import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  parseKimiLine,
  type UsageRecord,
} from "./usageTranscripts.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface TranscriptListing {
  readonly files: readonly TranscriptFile[];
  readonly failedEntries: number;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

export function resolveKimiDesktopDataDir(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  homeDir: string,
): string {
  const override = environment["KIMI_DESKTOP_DATA_DIR"]?.trim();
  if (override) return override;
  if (platform === "win32") {
    return NodePath.join(
      environment["APPDATA"]?.trim() || NodePath.join(homeDir, "AppData", "Roaming"),
      "kimi-desktop",
    );
  }
  if (platform === "darwin") {
    return NodePath.join(homeDir, "Library", "Application Support", "kimi-desktop");
  }
  return NodePath.join(
    environment["XDG_CONFIG_HOME"]?.trim() || NodePath.join(homeDir, ".config"),
    "kimi-desktop",
  );
}

/**
 * Lists `.jsonl` transcripts under `root` last modified at or after `sinceMs`.
 *
 * Errors on individual entries are swallowed: session files rotate and get
 * removed while the walk is in flight, and a partial listing is far better than
 * failing the page.
 */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
): Promise<TranscriptListing> {
  const found: TranscriptFile[] = [];
  let failedEntries = 0;

  const walk = async (dir: string, isRoot = false): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch (error) {
      // A nested entry may rotate away between its parent readdir and this
      // walk. The root disappearing after the caller's existence check is a
      // real source failure, as is any permission or I/O error.
      if (isRoot || errorCode(error) !== "ENOENT") failedEntries += 1;
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      try {
        const stats = await NodeFSP.stat(child);
        if (stats.mtimeMs >= sinceMs) {
          found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs });
        }
      } catch (error) {
        // Vanishing between readdir and stat is benign rotation; other errors
        // mean coverage is partial.
        if (errorCode(error) !== "ENOENT") failedEntries += 1;
      }
    }
  };

  await walk(root, true);
  return { files: found, failedEntries };
}

/**
 * Filesystem identity of a directory, as `device:inode`.
 *
 * Used to tell "two servers reading the same transcript directory" apart from
 * "two machines whose hostname and home path happen to match". Returns an empty
 * string when the directory cannot be stat'd.
 */
export async function readDirectoryVolumeId(path: string): Promise<string> {
  try {
    const stats = await NodeFSP.stat(path);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return "";
  }
}

export function kimiSessionIdFromTranscriptPath(filePath: string): string {
  const parts = NodePath.normalize(filePath).split(NodePath.sep);
  const sessionsIndex = parts.lastIndexOf("sessions");
  return sessionsIndex >= 0 ? (parts[sessionsIndex + 2] ?? "") : "";
}

/**
 * Streams one transcript and returns the usage records it contains, or `null`
 * when the file could not be read.
 *
 * The distinction matters to the caller's cache: a genuinely empty transcript
 * is a stable fact worth memoising, while a transient read failure memoised
 * under the same `(size, mtime)` key would silently drop that file's usage
 * until the file next changes.
 *
 * Codex carries the active model on `turn_context` lines that hold no usage of
 * their own, so those still have to pass through the reducer to keep model
 * attribution correct.
 */
export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
  kimiSinceMs = 0,
): Promise<readonly UsageRecord[] | null> {
  const records: UsageRecord[] = [];
  const codexState = initialCodexScanState();
  const kimiSessionId = provider === "kimi" ? kimiSessionIdFromTranscriptPath(filePath) : "";

  try {
    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (provider === "codex") {
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"turn_context"') &&
          !line.includes('"session_meta"')
        ) {
          continue;
        }
        const record = parseCodexLine(line, codexState);
        if (record !== null) records.push(record);
        continue;
      }

      if (provider === "kimi") {
        if (!mightCarryUsage(line, provider)) continue;
        const record = parseKimiLine(line, kimiSessionId);
        if (record !== null && record.timestampMs >= kimiSinceMs) records.push(record);
        continue;
      }

      if (!mightCarryUsage(line, provider)) continue;
      const record = parseClaudeLine(line);
      if (record !== null) records.push(record);
    }
  } catch {
    return null;
  }

  return records;
}
