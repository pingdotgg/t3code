import fs from "node:fs/promises";
import path from "node:path";

import {
  projectSearchEntriesInputSchema,
  type ProjectEntry,
  type ProjectSearchEntriesInput,
  type ProjectSearchEntriesResult,
} from "@t3tools/contracts";

const WORKSPACE_CACHE_TTL_MS = 15_000;
const WORKSPACE_CACHE_MAX_KEYS = 4;
const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);

interface WorkspaceIndex {
  scannedAt: number;
  entries: ProjectEntry[];
  truncated: boolean;
}

const workspaceIndexCache = new Map<string, WorkspaceIndex>();

function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return undefined;
  }
  return input.slice(0, separatorIndex);
}

function basenameOf(input: string): string {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return input;
  }
  return input.slice(separatorIndex + 1);
}

function normalizeQuery(input: string): string {
  return input.trim().replace(/^[@./]+/, "").toLowerCase();
}

function scoreEntry(entry: ProjectEntry, query: string): number {
  if (!query) {
    return entry.kind === "directory" ? 0 : 1;
  }

  const normalizedPath = entry.path.toLowerCase();
  const normalizedName = basenameOf(normalizedPath);

  if (normalizedName === query) return 0;
  if (normalizedPath === query) return 1;
  if (normalizedName.startsWith(query)) return 2;
  if (normalizedPath.startsWith(query)) return 3;
  if (normalizedPath.includes(`/${query}`)) return 4;
  return 5;
}

async function buildWorkspaceIndex(cwd: string): Promise<WorkspaceIndex> {
  let pendingDirectories: string[] = [""];
  const entries: ProjectEntry[] = [];
  let truncated = false;

  while (pendingDirectories.length > 0 && !truncated) {
    const currentDirectories = pendingDirectories;
    pendingDirectories = [];
    const directoryEntries = await Promise.all(
      currentDirectories.map(async (relativeDir) => {
        const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
        try {
          const dirents = await fs.readdir(absoluteDir, { withFileTypes: true });
          return { relativeDir, dirents };
        } catch (error) {
          if (!relativeDir) {
            throw new Error(
              `Unable to scan workspace entries at '${cwd}': ${error instanceof Error ? error.message : "unknown error"}`,
              { cause: error },
            );
          }
          return { relativeDir, dirents: null };
        }
      }),
    );

    for (const directoryEntry of directoryEntries) {
      const { relativeDir, dirents } = directoryEntry;
      if (!dirents) {
        continue;
      }

      dirents.sort((left, right) => left.name.localeCompare(right.name));
      for (const dirent of dirents) {
        if (!dirent.name || dirent.name === "." || dirent.name === "..") {
          continue;
        }
        if (dirent.isDirectory() && IGNORED_DIRECTORY_NAMES.has(dirent.name)) {
          continue;
        }
        if (!dirent.isDirectory() && !dirent.isFile()) {
          continue;
        }

        const relativePath = toPosixPath(
          relativeDir ? path.join(relativeDir, dirent.name) : dirent.name,
        );
        const entry: ProjectEntry = {
          path: relativePath,
          kind: dirent.isDirectory() ? "directory" : "file",
          parentPath: parentPathOf(relativePath),
        };
        entries.push(entry);

        if (dirent.isDirectory()) {
          pendingDirectories.push(relativePath);
        }

        if (entries.length >= WORKSPACE_INDEX_MAX_ENTRIES) {
          truncated = true;
          break;
        }
      }

      if (truncated) {
        break;
      }
    }
  }

  return {
    scannedAt: Date.now(),
    entries,
    truncated,
  };
}

async function getWorkspaceIndex(cwd: string): Promise<WorkspaceIndex> {
  const cached = workspaceIndexCache.get(cwd);
  if (cached && Date.now() - cached.scannedAt < WORKSPACE_CACHE_TTL_MS) {
    return cached;
  }

  const next = await buildWorkspaceIndex(cwd);
  workspaceIndexCache.set(cwd, next);
  while (workspaceIndexCache.size > WORKSPACE_CACHE_MAX_KEYS) {
    const oldestKey = workspaceIndexCache.keys().next().value;
    if (!oldestKey) break;
    workspaceIndexCache.delete(oldestKey);
  }
  return next;
}

export async function searchWorkspaceEntries(
  input: ProjectSearchEntriesInput,
): Promise<ProjectSearchEntriesResult> {
  const parsed = projectSearchEntriesInputSchema.parse(input);
  const index = await getWorkspaceIndex(parsed.cwd);
  const normalizedQuery = normalizeQuery(parsed.query);
  const candidates = normalizedQuery
    ? index.entries.filter((entry) => entry.path.toLowerCase().includes(normalizedQuery))
    : index.entries;

  const ranked = candidates.toSorted((left, right) => {
    const scoreDelta = scoreEntry(left, normalizedQuery) - scoreEntry(right, normalizedQuery);
    if (scoreDelta !== 0) return scoreDelta;
    return left.path.localeCompare(right.path);
  });

  return {
    entries: ranked.slice(0, parsed.limit),
    truncated: index.truncated || ranked.length > parsed.limit,
  };
}
