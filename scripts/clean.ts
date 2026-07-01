#!/usr/bin/env node
/**
 * Cross-platform workspace clean.
 *
 * Removes build artifacts and installed dependencies across the monorepo.
 * Replaces the previous POSIX-only `rm -rf` recipe so `bun run clean` works
 * identically on Windows, macOS, and Linux.
 */
import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Workspace parents whose immediate child directories are cleaned per-target. */
const WORKSPACE_GROUPS = ["apps", "packages"] as const;

/** Directory names removed from the repo root. */
const ROOT_TARGETS = ["node_modules", ".turbo"] as const;

/** Directory names removed from each workspace package. */
const PACKAGE_TARGETS = ["node_modules", "dist", "dist-electron", ".turbo"] as const;

async function removeDir(absolutePath: string): Promise<void> {
  await rm(absolutePath, { recursive: true, force: true });
}

async function listChildDirectories(parent: string): Promise<ReadonlyArray<string>> {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(parent, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const removals: string[] = [];

  for (const target of ROOT_TARGETS) {
    removals.push(join(repoRoot, target));
  }

  for (const group of WORKSPACE_GROUPS) {
    const packages = await listChildDirectories(join(repoRoot, group));
    for (const packageDir of packages) {
      for (const target of PACKAGE_TARGETS) {
        removals.push(join(packageDir, target));
      }
    }
  }

  await Promise.all(removals.map(removeDir));
}

main().catch((error: unknown) => {
  console.error("[clean] failed:", error);
  process.exitCode = 1;
});
