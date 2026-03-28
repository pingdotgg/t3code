import { lstat, mkdir, readFile, readdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

async function pathStat(path) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

async function listChildDirectories(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

function dedupeAndSort(paths) {
  return [...new Set(paths)].toSorted((left, right) => left.localeCompare(right));
}

async function expandWorkspacePatternFrom(baseDir, segments) {
  if (segments.length === 0) {
    return [baseDir];
  }

  const [segment, ...rest] = segments;
  if (segment === "**") {
    const directMatches = await expandWorkspacePatternFrom(baseDir, rest);
    const childDirectories = await listChildDirectories(baseDir);
    const recursiveMatches = await Promise.all(
      childDirectories.map((childDirectory) =>
        expandWorkspacePatternFrom(childDirectory, segments),
      ),
    );
    return dedupeAndSort([...directMatches, ...recursiveMatches.flat()]);
  }

  if (segment === "*") {
    const childDirectories = await listChildDirectories(baseDir);
    const matches = await Promise.all(
      childDirectories.map((childDirectory) => expandWorkspacePatternFrom(childDirectory, rest)),
    );
    return dedupeAndSort(matches.flat());
  }

  const nextDirectory = join(baseDir, segment);
  const stat = await pathStat(nextDirectory);
  if (!stat?.isDirectory()) {
    return [];
  }

  return expandWorkspacePatternFrom(nextDirectory, rest);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function expandWorkspacePattern(repoRoot, pattern) {
  const segments = pattern.split(/[\\/]/).filter((segment) => segment.length > 0);
  return dedupeAndSort(await expandWorkspacePatternFrom(repoRoot, segments));
}

export async function collectWorkspacePackages(repoRoot) {
  const rootPackageJsonPath = join(repoRoot, "package.json");
  const rootPackageJson = await readJson(rootPackageJsonPath);
  const packagePatterns = rootPackageJson.workspaces?.packages ?? [];
  const directories = dedupeAndSort(
    (
      await Promise.all(packagePatterns.map((pattern) => expandWorkspacePattern(repoRoot, pattern)))
    ).flat(),
  );

  const packages = [];
  const seenByName = new Map();

  for (const directory of directories) {
    const packageJsonPath = join(directory, "package.json");
    try {
      const manifest = await readJson(packageJsonPath);
      if (typeof manifest.name !== "string" || manifest.name.length === 0) {
        continue;
      }

      const existingDirectory = seenByName.get(manifest.name);
      if (existingDirectory && existingDirectory !== directory) {
        throw new Error(
          `Duplicate workspace package name "${manifest.name}" in ${existingDirectory} and ${directory}.`,
        );
      }

      seenByName.set(manifest.name, directory);
      packages.push({
        name: manifest.name,
        directory,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Duplicate workspace package name")) {
        throw error;
      }
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return packages.toSorted((left, right) => left.name.localeCompare(right.name));
}

export async function ensureWorkspaceLink({ rootNodeModulesDir, name, directory }) {
  const destination = join(rootNodeModulesDir, name);
  const target = relative(dirname(destination), directory);

  await mkdir(dirname(destination), { recursive: true });

  try {
    const stat = await lstat(destination);
    if (stat.isSymbolicLink()) {
      const existingTarget = await readlink(destination);
      if (existingTarget === target) {
        return;
      }
    }
    await rm(destination, { recursive: true, force: true });
  } catch {
    // Missing destination is fine.
  }

  await symlink(target, destination, process.platform === "win32" ? "junction" : "dir");
}

export async function syncWorkspaceLinks(repoRoot) {
  const resolvedRepoRoot = resolve(repoRoot);
  const rootNodeModulesDir = join(resolvedRepoRoot, "node_modules");
  const workspacePackages = await collectWorkspacePackages(resolvedRepoRoot);

  await mkdir(rootNodeModulesDir, { recursive: true });
  await Promise.all(
    workspacePackages.map(({ name, directory }) =>
      ensureWorkspaceLink({
        rootNodeModulesDir,
        name,
        directory,
      }),
    ),
  );
}
