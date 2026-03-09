import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import {
  filterGitIgnoredPaths,
  IGNORED_DIRECTORY_NAMES,
  isInsideGitWorkTree,
  isPathInIgnoredDirectory,
  listGitVisibleFilePathsResult,
  mapWithConcurrency,
  toPosixPath,
} from "./projectFiles";

import {
  ProjectEntry,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";

const WORKSPACE_CACHE_TTL_MS = 15_000;
const WORKSPACE_CACHE_MAX_KEYS = 4;
const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_SCAN_READDIR_CONCURRENCY = 32;

interface WorkspaceIndex {
  scannedAt: number;
  entries: ProjectEntry[];
  truncated: boolean;
}

const workspaceIndexCache = new Map<string, WorkspaceIndex>();
const inFlightWorkspaceIndexBuilds = new Map<string, Promise<WorkspaceIndex>>();

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
  return input
    .trim()
    .replace(/^[@./]+/, "")
    .toLowerCase();
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

function directoryAncestorsOf(relativePath: string): string[] {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 1) return [];
  const directories: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index).join("/"));
  }
  return directories;
}

async function buildWorkspaceIndexFromGit(cwd: string): Promise<WorkspaceIndex | null> {
  const gitVisibleFiles = await listGitVisibleFilePathsResult(cwd);
  if (!gitVisibleFiles) {
    return null;
  }
  const { paths: filePaths, truncated: gitPathsTruncated } = gitVisibleFiles;

  const directorySet = new Set<string>();
  for (const filePath of filePaths) {
    for (const directoryPath of directoryAncestorsOf(filePath)) {
      if (!isPathInIgnoredDirectory(directoryPath)) {
        directorySet.add(directoryPath);
      }
    }
  }

  const directoryEntries: ProjectEntry[] = [...directorySet]
    .toSorted((left, right) => left.localeCompare(right))
    .map((directoryPath) => ({
      path: directoryPath,
      kind: "directory",
      parentPath: parentPathOf(directoryPath),
    }));
  const fileEntries: ProjectEntry[] = [...new Set(filePaths)]
    .toSorted((left, right) => left.localeCompare(right))
    .map((filePath) => ({
      path: filePath,
      kind: "file",
      parentPath: parentPathOf(filePath),
    }));

  const entries = [...directoryEntries, ...fileEntries];
  return {
    scannedAt: Date.now(),
    entries: entries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES),
    truncated: gitPathsTruncated || entries.length > WORKSPACE_INDEX_MAX_ENTRIES,
  };
}

async function buildWorkspaceIndex(cwd: string): Promise<WorkspaceIndex> {
  const gitIndexed = await buildWorkspaceIndexFromGit(cwd);
  if (gitIndexed) {
    return gitIndexed;
  }
  const shouldFilterWithGitIgnore = await isInsideGitWorkTree(cwd);

  let pendingDirectories: string[] = [""];
  const entries: ProjectEntry[] = [];
  let truncated = false;

  while (pendingDirectories.length > 0 && !truncated) {
    const currentDirectories = pendingDirectories;
    pendingDirectories = [];
    const directoryEntries = await mapWithConcurrency(
      currentDirectories,
      WORKSPACE_SCAN_READDIR_CONCURRENCY,
      async (relativeDir) => {
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
      },
    );

    const candidateEntriesByDirectory = directoryEntries.map((directoryEntry) => {
      const { relativeDir, dirents } = directoryEntry;
      if (!dirents) return [] as Array<{ dirent: Dirent; relativePath: string }>;

      dirents.sort((left, right) => left.name.localeCompare(right.name));
      const candidates: Array<{ dirent: Dirent; relativePath: string }> = [];
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
        if (isPathInIgnoredDirectory(relativePath)) {
          continue;
        }
        candidates.push({ dirent, relativePath });
      }
      return candidates;
    });

    const candidatePaths = candidateEntriesByDirectory.flatMap((candidateEntries) =>
      candidateEntries.map((entry) => entry.relativePath),
    );
    const allowedPathSet = shouldFilterWithGitIgnore
      ? new Set(await filterGitIgnoredPaths(cwd, candidatePaths))
      : null;

    for (const candidateEntries of candidateEntriesByDirectory) {
      for (const candidate of candidateEntries) {
        if (allowedPathSet && !allowedPathSet.has(candidate.relativePath)) {
          continue;
        }

        const entry: ProjectEntry = {
          path: candidate.relativePath,
          kind: candidate.dirent.isDirectory() ? "directory" : "file",
          parentPath: parentPathOf(candidate.relativePath),
        };
        entries.push(entry);

        if (candidate.dirent.isDirectory()) {
          pendingDirectories.push(candidate.relativePath);
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

  const inFlight = inFlightWorkspaceIndexBuilds.get(cwd);
  if (inFlight) {
    return inFlight;
  }

  const nextPromise = buildWorkspaceIndex(cwd)
    .then((next) => {
      workspaceIndexCache.set(cwd, next);
      while (workspaceIndexCache.size > WORKSPACE_CACHE_MAX_KEYS) {
        const oldestKey = workspaceIndexCache.keys().next().value;
        if (!oldestKey) break;
        workspaceIndexCache.delete(oldestKey);
      }
      return next;
    })
    .finally(() => {
      inFlightWorkspaceIndexBuilds.delete(cwd);
    });
  inFlightWorkspaceIndexBuilds.set(cwd, nextPromise);
  return nextPromise;
}

export async function searchWorkspaceEntries(
  input: ProjectSearchEntriesInput,
): Promise<ProjectSearchEntriesResult> {
  const index = await getWorkspaceIndex(input.cwd);
  const normalizedQuery = normalizeQuery(input.query);
  const candidates = normalizedQuery
    ? index.entries.filter((entry) => entry.path.toLowerCase().includes(normalizedQuery))
    : index.entries;

  const ranked = candidates.toSorted((left, right) => {
    const scoreDelta = scoreEntry(left, normalizedQuery) - scoreEntry(right, normalizedQuery);
    if (scoreDelta !== 0) return scoreDelta;
    return left.path.localeCompare(right.path);
  });

  return {
    entries: ranked.slice(0, input.limit),
    truncated: index.truncated || ranked.length > input.limit,
  };
}
