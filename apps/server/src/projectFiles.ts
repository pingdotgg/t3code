import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { runProcess } from "./processRunner";

const PROJECT_SCAN_READDIR_CONCURRENCY = 32;
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;

export const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);

export function toPosixPath(input: string): string {
  return input.split(path.sep).join("/");
}

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

export function isPathInIgnoredDirectory(relativePath: string): boolean {
  const firstSegment = relativePath.split("/")[0];
  if (!firstSegment) return false;
  return IGNORED_DIRECTORY_NAMES.has(firstSegment);
}

export async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) {
    return [];
  }

  const boundedConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = Array.from({ length: items.length }) as TOutput[];
  let nextIndex = 0;

  const workers = Array.from({ length: boundedConcurrency }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex] as TInput, currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function isInsideGitWorkTree(cwd: string): Promise<boolean> {
  const insideWorkTree = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    allowNonZeroExit: true,
    timeoutMs: 5_000,
    maxBufferBytes: 4_096,
  }).catch(() => null);
  return Boolean(
    insideWorkTree && insideWorkTree.code === 0 && insideWorkTree.stdout.trim() === "true",
  );
}

export async function filterGitIgnoredPaths(
  cwd: string,
  relativePaths: string[],
): Promise<string[]> {
  if (relativePaths.length === 0) {
    return relativePaths;
  }

  const ignoredPaths = new Set<string>();
  let chunk: string[] = [];
  let chunkBytes = 0;

  const flushChunk = async (): Promise<boolean> => {
    if (chunk.length === 0) {
      return true;
    }

    const checkIgnore = await runProcess("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 20_000,
      maxBufferBytes: 16 * 1024 * 1024,
      outputMode: "truncate",
      stdin: `${chunk.join("\0")}\0`,
    }).catch(() => null);
    chunk = [];
    chunkBytes = 0;

    if (!checkIgnore) {
      return false;
    }

    // git-check-ignore exits with 1 when no paths match.
    if (checkIgnore.code !== 0 && checkIgnore.code !== 1) {
      return false;
    }

    const matchedIgnoredPaths = splitNullSeparatedPaths(
      checkIgnore.stdout,
      Boolean(checkIgnore.stdoutTruncated),
    );
    for (const ignoredPath of matchedIgnoredPaths) {
      ignoredPaths.add(ignoredPath);
    }
    return true;
  };

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (
      chunk.length > 0 &&
      chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES &&
      !(await flushChunk())
    ) {
      return relativePaths;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES && !(await flushChunk())) {
      return relativePaths;
    }
  }

  if (!(await flushChunk())) {
    return relativePaths;
  }

  if (ignoredPaths.size === 0) {
    return relativePaths;
  }

  return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
}

export interface GitVisibleFilePathsResult {
  paths: string[];
  truncated: boolean;
}

export async function listGitVisibleFilePathsResult(
  cwd: string,
): Promise<GitVisibleFilePathsResult | null> {
  if (!(await isInsideGitWorkTree(cwd))) {
    return null;
  }

  const listedFiles = await runProcess(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 20_000,
      maxBufferBytes: 16 * 1024 * 1024,
      outputMode: "truncate",
    },
  ).catch(() => null);
  if (!listedFiles || listedFiles.code !== 0) {
    return null;
  }

  const listedPaths = splitNullSeparatedPaths(
    listedFiles.stdout,
    Boolean(listedFiles.stdoutTruncated),
  )
    .map((entry) => toPosixPath(entry))
    .filter((entry) => entry.length > 0 && !isPathInIgnoredDirectory(entry));
  return {
    paths: await filterGitIgnoredPaths(cwd, listedPaths),
    truncated: Boolean(listedFiles.stdoutTruncated),
  };
}

export async function listGitVisibleFilePaths(cwd: string): Promise<string[] | null> {
  const result = await listGitVisibleFilePathsResult(cwd);
  return result?.paths ?? null;
}

export async function listProjectFilePaths(cwd: string): Promise<string[]> {
  const gitVisibleFiles = await listGitVisibleFilePaths(cwd);
  if (gitVisibleFiles) {
    return gitVisibleFiles;
  }

  let pendingDirectories: string[] = [""];
  const filePaths: string[] = [];

  while (pendingDirectories.length > 0) {
    const currentDirectories = pendingDirectories;
    pendingDirectories = [];

    const directoryEntries = await mapWithConcurrency(
      currentDirectories,
      PROJECT_SCAN_READDIR_CONCURRENCY,
      async (relativeDir) => {
        const absoluteDir = relativeDir ? path.join(cwd, relativeDir) : cwd;
        try {
          const dirents = await fs.readdir(absoluteDir, { withFileTypes: true });
          return { relativeDir, dirents };
        } catch (error) {
          if (!relativeDir) {
            throw new Error(
              `Unable to scan project files at '${cwd}': ${error instanceof Error ? error.message : "unknown error"}`,
              { cause: error },
            );
          }
          return { relativeDir, dirents: null };
        }
      },
    );

    for (const directoryEntry of directoryEntries) {
      const dirents = directoryEntry.dirents?.toSorted((left, right) =>
        left.name.localeCompare(right.name),
      );
      if (!dirents) {
        continue;
      }

      for (const dirent of dirents) {
        const relativePath = toPosixPath(
          directoryEntry.relativeDir
            ? path.join(directoryEntry.relativeDir, dirent.name)
            : dirent.name,
        );
        if (!shouldIncludeDirent(relativePath, dirent)) {
          continue;
        }

        if (dirent.isDirectory()) {
          pendingDirectories.push(relativePath);
          continue;
        }

        filePaths.push(relativePath);
      }
    }
  }

  return filePaths;
}

function shouldIncludeDirent(relativePath: string, dirent: Dirent): boolean {
  if (!dirent.name || dirent.name === "." || dirent.name === "..") {
    return false;
  }
  if (!dirent.isDirectory() && !dirent.isFile()) {
    return false;
  }
  if (isPathInIgnoredDirectory(relativePath)) {
    return false;
  }
  return true;
}
