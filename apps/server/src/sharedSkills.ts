import os from "node:os";
import path from "node:path";
import { promises as fs, type Dirent } from "node:fs";

import type {
  SharedSkill,
  SharedSkillDetail,
  SharedSkillDetailInput,
  SharedSkillsConfigInput,
  SharedSkillsState,
  SharedSkillSetEnabledInput,
  SharedSkillUninstallInput,
} from "@t3tools/contracts";

const SKILL_MARKDOWN_FILE = "SKILL.md";
const SKILL_MANIFEST_FILE = "SKILL.json";
const SHARED_SKILLS_MARKER_FILE = ".t3code-shared-skills.json";

interface SharedSkillsMarkerData {
  version: number;
  initializedAt: string;
  codexHomePath: string;
  disabledSkillNames: string[];
}

interface ResolvedSharedSkillsPaths {
  codexHomePath: string;
  codexSkillsPath: string;
  agentsSkillsPath: string;
  sharedSkillsPath: string;
  initializationMarkerPath: string;
}

interface SkillManifestMetadata {
  displayName: string | null;
  shortDescription: string | null;
  iconPath: string | null;
  brandColor: string | null;
}

interface DiskSkillEntry extends SkillManifestMetadata {
  name: string;
  path: string;
  isSymlink: boolean;
  hasSkillMarkdown: boolean;
  realPath: string | null;
  description: string | null;
  markdownPath: string;
}

const sharedSkillsOperationLocks = new Map<string, Promise<void>>();

function toSkillName(rootPath: string, entryPath: string): string {
  return path.relative(rootPath, entryPath).split(path.sep).join("/");
}

function normalizeDisabledSkillNames(values: readonly string[] | undefined): string[] {
  return [
    ...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length)),
  ].toSorted((left, right) => left.localeCompare(right));
}

function expandHomePath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolveConfiguredPath(rawPath: string | null | undefined, fallbackPath: string): string {
  const trimmed = rawPath?.trim() ?? "";
  const value = trimmed.length > 0 ? trimmed : fallbackPath;
  return path.resolve(expandHomePath(value));
}

function resolveSharedSkillsPaths(input: SharedSkillsConfigInput): ResolvedSharedSkillsPaths {
  const codexHomePath = resolveConfiguredPath(
    input.codexHomePath,
    path.join(os.homedir(), ".codex"),
  );
  const agentsSkillsPath = path.resolve(os.homedir(), ".agents", "skills");
  const sharedSkillsPath = resolveConfiguredPath(
    input.sharedSkillsPath,
    path.join(os.homedir(), "Documents", "skills"),
  );

  return {
    codexHomePath,
    codexSkillsPath: path.join(codexHomePath, "skills"),
    agentsSkillsPath,
    sharedSkillsPath,
    initializationMarkerPath: path.join(sharedSkillsPath, SHARED_SKILLS_MARKER_FILE),
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function isFile(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isFile();
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT" || errorCode === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

async function readSkillMarkdown(skillPath: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(skillPath, SKILL_MARKDOWN_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function extractDescriptionFromFrontmatter(markdown: string): string | null {
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return null;
  }

  const descriptionLine = (frontmatterMatch[1] ?? "")
    .split("\n")
    .find((line) => line.trimStart().startsWith("description:"));
  if (!descriptionLine) {
    return null;
  }

  const description = descriptionLine.replace(/^.*description:\s*/, "").trim();
  return description.replace(/^["']|["']$/g, "") || null;
}

function resolveSkillIconPath(skillPath: string, iconPath: unknown): string | null {
  if (typeof iconPath !== "string" || iconPath.length === 0) {
    return null;
  }

  if (path.isAbsolute(iconPath)) {
    return iconPath;
  }

  return path.resolve(skillPath, iconPath);
}

async function readSkillManifest(skillPath: string): Promise<SkillManifestMetadata> {
  let contents: string;
  try {
    contents = await fs.readFile(path.join(skillPath, SKILL_MANIFEST_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        displayName: null,
        shortDescription: null,
        iconPath: null,
        brandColor: null,
      };
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(contents) as {
      interface?: {
        brandColor?: unknown;
        displayName?: unknown;
        iconLarge?: unknown;
        iconSmall?: unknown;
        shortDescription?: unknown;
      };
    };
    const interfaceConfig = parsed.interface;

    return {
      displayName:
        typeof interfaceConfig?.displayName === "string" ? interfaceConfig.displayName : null,
      shortDescription:
        typeof interfaceConfig?.shortDescription === "string"
          ? interfaceConfig.shortDescription
          : null,
      iconPath: resolveSkillIconPath(
        skillPath,
        interfaceConfig?.iconSmall ?? interfaceConfig?.iconLarge,
      ),
      brandColor:
        typeof interfaceConfig?.brandColor === "string" ? interfaceConfig.brandColor : null,
    };
  } catch {
    return {
      displayName: null,
      shortDescription: null,
      iconPath: null,
      brandColor: null,
    };
  }
}

async function readInitializationMarker(
  paths: ResolvedSharedSkillsPaths,
): Promise<SharedSkillsMarkerData | null> {
  let contents: string;
  try {
    contents = await fs.readFile(paths.initializationMarkerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(contents) as Partial<SharedSkillsMarkerData>;
    return {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      initializedAt:
        typeof parsed.initializedAt === "string" && parsed.initializedAt.length > 0
          ? parsed.initializedAt
          : new Date().toISOString(),
      codexHomePath:
        typeof parsed.codexHomePath === "string" && parsed.codexHomePath.length > 0
          ? parsed.codexHomePath
          : paths.codexHomePath,
      disabledSkillNames: normalizeDisabledSkillNames(parsed.disabledSkillNames),
    };
  } catch {
    return {
      version: 1,
      initializedAt: new Date().toISOString(),
      codexHomePath: paths.codexHomePath,
      disabledSkillNames: [],
    };
  }
}

async function writeInitializationMarker(
  paths: ResolvedSharedSkillsPaths,
  marker: SharedSkillsMarkerData,
): Promise<void> {
  await fs.mkdir(path.dirname(paths.initializationMarkerPath), { recursive: true });
  await fs.writeFile(
    paths.initializationMarkerPath,
    JSON.stringify(
      {
        ...marker,
        disabledSkillNames: normalizeDisabledSkillNames(marker.disabledSkillNames),
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function withSharedSkillsLock<T>(
  paths: ResolvedSharedSkillsPaths,
  operation: () => Promise<T>,
): Promise<T> {
  const lockKey = paths.initializationMarkerPath;
  const previousOperation = sharedSkillsOperationLocks.get(lockKey) ?? Promise.resolve();
  const runOperation = previousOperation.catch(() => undefined).then(operation);
  const settledOperation = runOperation.then(
    () => undefined,
    () => undefined,
  );

  sharedSkillsOperationLocks.set(lockKey, settledOperation);

  try {
    return await runOperation;
  } finally {
    if (sharedSkillsOperationLocks.get(lockKey) === settledOperation) {
      sharedSkillsOperationLocks.delete(lockKey);
    }
  }
}

async function readSkillEntries(rootPath: string): Promise<Map<string, DiskSkillEntry>> {
  async function walkDirectory(
    currentPath: string,
    entries: Map<string, DiskSkillEntry>,
    visitedDirectories: Set<string>,
  ): Promise<void> {
    let dirents: Dirent<string>[];
    try {
      dirents = await fs.readdir(currentPath, { encoding: "utf8", withFileTypes: true });
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode === "ENOENT" || errorCode === "ENOTDIR") {
        return;
      }
      throw error;
    }

    await Promise.all(
      dirents.map(async (dirent) => {
        if (!dirent.isDirectory() && !dirent.isSymbolicLink()) {
          return;
        }

        const entryPath = path.join(currentPath, dirent.name);
        const stat = await fs.lstat(entryPath);
        const realPath = await fs.realpath(entryPath).catch(() => null);
        const markdownPath = path.join(entryPath, SKILL_MARKDOWN_FILE);
        const hasSkillMarkdown = await isFile(markdownPath);
        if (stat.isSymbolicLink() && realPath === null) {
          const name = toSkillName(rootPath, entryPath);
          entries.set(name, {
            name,
            path: entryPath,
            isSymlink: true,
            hasSkillMarkdown: false,
            realPath: null,
            description: null,
            markdownPath,
            displayName: null,
            shortDescription: null,
            iconPath: null,
            brandColor: null,
          });
          return;
        }

        if (hasSkillMarkdown) {
          const markdown = await readSkillMarkdown(entryPath);
          const description = markdown ? extractDescriptionFromFrontmatter(markdown) : null;
          const manifest = await readSkillManifest(entryPath);

          entries.set(toSkillName(rootPath, entryPath), {
            name: toSkillName(rootPath, entryPath),
            path: entryPath,
            isSymlink: stat.isSymbolicLink(),
            hasSkillMarkdown,
            realPath,
            description,
            markdownPath,
            ...manifest,
          });
          return;
        }

        const traversalKey = await fs.realpath(entryPath).catch(() => path.resolve(entryPath));
        if (visitedDirectories.has(traversalKey)) {
          return;
        }

        visitedDirectories.add(traversalKey);
        await walkDirectory(entryPath, entries, visitedDirectories);
      }),
    );
  }

  try {
    const stat = await fs.stat(rootPath);
    if (!stat.isDirectory()) {
      return new Map();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Map();
    }
    throw error;
  }

  const entries = new Map<string, DiskSkillEntry>();
  const visitedDirectories = new Set<string>([
    await fs.realpath(rootPath).catch(() => path.resolve(rootPath)),
  ]);
  await walkDirectory(rootPath, entries, visitedDirectories);

  return entries;
}

function isCodexVisible(entry: DiskSkillEntry | undefined): boolean {
  if (!entry) {
    return false;
  }

  if (!entry.isSymlink) {
    return entry.hasSkillMarkdown;
  }

  return entry.hasSkillMarkdown && entry.realPath !== null;
}

function isSystemSkillName(name: string): boolean {
  return name === ".system" || name.startsWith(".system/");
}

function skillPathFromName(rootPath: string, skillName: string): string {
  return path.join(rootPath, ...skillName.split("/"));
}

function preferredHarnessSkillPath(paths: ResolvedSharedSkillsPaths, skillName: string): string {
  return isSystemSkillName(skillName)
    ? skillPathFromName(paths.codexSkillsPath, skillName)
    : skillPathFromName(paths.agentsSkillsPath, skillName);
}

function containingHarnessRoot(paths: ResolvedSharedSkillsPaths, entryPath: string): string | null {
  const normalizedEntryPath = path.resolve(entryPath);
  const candidateRoots = [paths.codexSkillsPath, paths.agentsSkillsPath].map((rootPath) =>
    path.resolve(rootPath),
  );

  return (
    candidateRoots.find(
      (rootPath) =>
        normalizedEntryPath === rootPath ||
        normalizedEntryPath.startsWith(`${rootPath}${path.sep}`),
    ) ?? null
  );
}

async function readHarnessSkillEntries(
  paths: ResolvedSharedSkillsPaths,
): Promise<Map<string, DiskSkillEntry>> {
  const [codexEntries, agentsEntries] = await Promise.all([
    readSkillEntries(paths.codexSkillsPath),
    readSkillEntries(paths.agentsSkillsPath),
  ]);

  const merged = new Map<string, DiskSkillEntry>(codexEntries);
  for (const [name, entry] of agentsEntries) {
    merged.set(name, entry);
  }

  return merged;
}

function toSharedSkillSummary(input: {
  name: string;
  paths: ResolvedSharedSkillsPaths;
  sharedEntry: DiskSkillEntry | undefined;
  codexEntry: DiskSkillEntry | undefined;
}): SharedSkill {
  const { codexEntry, name, paths, sharedEntry } = input;
  const codexPath = codexEntry?.path ?? preferredHarnessSkillPath(paths, name);
  const sharedPath = skillPathFromName(paths.sharedSkillsPath, name);
  const symlinkedToSharedPath =
    codexEntry !== undefined &&
    sharedEntry !== undefined &&
    codexEntry.isSymlink &&
    codexEntry.realPath !== null &&
    sharedEntry.realPath !== null &&
    codexEntry.realPath === sharedEntry.realPath;

  let status: SharedSkill["status"];
  if (codexEntry?.isSymlink && codexEntry.realPath === null) {
    status = "broken-link";
  } else if (sharedEntry && codexEntry) {
    status = symlinkedToSharedPath ? "managed" : "conflict";
  } else if (sharedEntry) {
    status = "needs-link";
  } else {
    status = "needs-migration";
  }

  const preferredEntry = sharedEntry ?? codexEntry;

  return {
    name,
    description: preferredEntry?.description ?? undefined,
    displayName: preferredEntry?.displayName ?? undefined,
    shortDescription: preferredEntry?.shortDescription ?? undefined,
    iconPath: preferredEntry?.iconPath ?? undefined,
    brandColor: preferredEntry?.brandColor ?? undefined,
    markdownPath: preferredEntry?.markdownPath ?? path.join(sharedPath, SKILL_MARKDOWN_FILE),
    enabled: isCodexVisible(codexEntry),
    status,
    codexPath,
    sharedPath,
    codexPathExists: codexEntry !== undefined,
    sharedPathExists: sharedEntry !== undefined,
    symlinkedToSharedPath,
  };
}

async function buildSharedSkillsState(
  paths: ResolvedSharedSkillsPaths,
  input: {
    isInitialized: boolean;
    warnings: string[];
  },
): Promise<SharedSkillsState> {
  const [sharedEntries, codexEntries] = await Promise.all([
    readSkillEntries(paths.sharedSkillsPath),
    readHarnessSkillEntries(paths),
  ]);

  const skillNames = new Set([...sharedEntries.keys(), ...codexEntries.keys()]);
  const skills: SharedSkill[] = [];

  for (const name of Array.from(skillNames).toSorted((left, right) => left.localeCompare(right))) {
    skills.push(
      toSharedSkillSummary({
        name,
        paths,
        sharedEntry: sharedEntries.get(name),
        codexEntry: codexEntries.get(name),
      }),
    );
  }

  return {
    codexHomePath: paths.codexHomePath,
    codexSkillsPath: paths.codexSkillsPath,
    agentsSkillsPath: paths.agentsSkillsPath,
    sharedSkillsPath: paths.sharedSkillsPath,
    initializationMarkerPath: paths.initializationMarkerPath,
    isInitialized: input.isInitialized,
    skills,
    warnings: input.warnings,
  };
}

async function moveDirectory(sourcePath: string, destinationPath: string): Promise<void> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    await fs.rename(sourcePath, destinationPath);
    return;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "EXDEV") {
      throw error;
    }
  }

  await fs.cp(sourcePath, destinationPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await fs.rm(sourcePath, { recursive: true, force: true });
}

async function removePath(targetPath: string): Promise<void> {
  await fs.rm(targetPath, {
    recursive: true,
    force: true,
  });
}

async function removeEmptyParentDirectories(rootPath: string, leafPath: string): Promise<void> {
  let currentPath = path.dirname(leafPath);
  const normalizedRootPath = path.resolve(rootPath);

  while (currentPath.startsWith(normalizedRootPath) && currentPath !== normalizedRootPath) {
    const remainingEntries = await fs.readdir(currentPath).catch(() => null);
    if (remainingEntries === null || remainingEntries.length > 0) {
      return;
    }

    await fs.rmdir(currentPath).catch(() => undefined);
    currentPath = path.dirname(currentPath);
  }
}

async function createDirectorySymlink(targetPath: string, symlinkPath: string): Promise<void> {
  await fs.mkdir(path.dirname(symlinkPath), { recursive: true });
  await fs.symlink(targetPath, symlinkPath, process.platform === "win32" ? "junction" : "dir");
}

async function reconcileSharedSkills(
  paths: ResolvedSharedSkillsPaths,
  disabledSkillNames: Set<string>,
  options: {
    migrateDiscoveredSkills: boolean;
  },
): Promise<string[]> {
  await Promise.all([
    fs.mkdir(paths.codexSkillsPath, { recursive: true }),
    fs.mkdir(paths.agentsSkillsPath, { recursive: true }),
    fs.mkdir(paths.sharedSkillsPath, { recursive: true }),
  ]);

  const warnings: string[] = [];
  const [sharedEntries, codexEntries] = await Promise.all([
    readSkillEntries(paths.sharedSkillsPath),
    readHarnessSkillEntries(paths),
  ]);

  for (const [name, sharedEntry] of sharedEntries) {
    const codexEntry = codexEntries.get(name);
    if (disabledSkillNames.has(name)) {
      if (codexEntry?.isSymlink) {
        await removePath(codexEntry.path);
        const containingRoot = containingHarnessRoot(paths, codexEntry.path);
        if (containingRoot) {
          await removeEmptyParentDirectories(containingRoot, codexEntry.path);
        }
      } else if (codexEntry) {
        warnings.push(
          `Codex skill '${name}' could not be disabled because a real directory still exists at '${codexEntry.path}'.`,
        );
      }
      continue;
    }

    if (!codexEntry) {
      await createDirectorySymlink(sharedEntry.path, preferredHarnessSkillPath(paths, name));
      continue;
    }

    if (codexEntry.isSymlink) {
      if (
        codexEntry.realPath !== null &&
        sharedEntry.realPath !== null &&
        codexEntry.realPath === sharedEntry.realPath
      ) {
        continue;
      }

      await removePath(codexEntry.path);
      const containingRoot = containingHarnessRoot(paths, codexEntry.path);
      if (containingRoot) {
        await removeEmptyParentDirectories(containingRoot, codexEntry.path);
      }
      await createDirectorySymlink(sharedEntry.path, codexEntry.path);
      continue;
    }

    warnings.push(
      `Codex skill '${name}' was left in place because '${sharedEntry.path}' already exists.`,
    );
  }

  for (const [name, codexEntry] of codexEntries) {
    if (sharedEntries.has(name)) {
      continue;
    }

    if (!options.migrateDiscoveredSkills) {
      if (codexEntry.isSymlink && (!codexEntry.hasSkillMarkdown || codexEntry.realPath === null)) {
        warnings.push(
          `Skill '${name}' points to a missing directory and could not be migrated. Restore or reinstall it, then click Move skills.`,
        );
      }
      continue;
    }

    const destinationPath = skillPathFromName(paths.sharedSkillsPath, name);
    if (await pathExists(destinationPath)) {
      warnings.push(
        `Shared skill destination '${destinationPath}' already exists for '${name}', so it was not migrated.`,
      );
      continue;
    }

    disabledSkillNames.delete(name);

    if (codexEntry.isSymlink) {
      if (!codexEntry.hasSkillMarkdown || codexEntry.realPath === null) {
        warnings.push(
          `Skill '${name}' points to a missing directory and could not be migrated. Restore or reinstall it, then click Recheck skills.`,
        );
        continue;
      }

      await moveDirectory(codexEntry.realPath, destinationPath);
      await removePath(codexEntry.path);
      const containingRoot = containingHarnessRoot(paths, codexEntry.path);
      if (containingRoot) {
        await removeEmptyParentDirectories(containingRoot, codexEntry.path);
      }
      await createDirectorySymlink(destinationPath, codexEntry.path);
      continue;
    }

    await moveDirectory(codexEntry.path, destinationPath);
    await createDirectorySymlink(destinationPath, codexEntry.path);
  }

  return warnings;
}

async function findSkillEntries(paths: ResolvedSharedSkillsPaths, skillName: string) {
  const [sharedEntries, codexEntries] = await Promise.all([
    readSkillEntries(paths.sharedSkillsPath),
    readHarnessSkillEntries(paths),
  ]);

  return {
    codexEntry: codexEntries.get(skillName),
    sharedEntry: sharedEntries.get(skillName),
  };
}

async function ensureSharedSkillMaterialized(
  paths: ResolvedSharedSkillsPaths,
  skillName: string,
): Promise<{ codexEntry: DiskSkillEntry | undefined; sharedEntry: DiskSkillEntry }> {
  const { codexEntry, sharedEntry } = await findSkillEntries(paths, skillName);
  if (sharedEntry) {
    return { codexEntry, sharedEntry };
  }

  if (!codexEntry || !codexEntry.hasSkillMarkdown) {
    throw new Error(`Skill '${skillName}' was not found.`);
  }

  const destinationPath = skillPathFromName(paths.sharedSkillsPath, skillName);
  if (await pathExists(destinationPath)) {
    throw new Error(`Shared skill destination '${destinationPath}' already exists.`);
  }

  if (codexEntry.isSymlink) {
    if (codexEntry.realPath === null) {
      throw new Error(`Skill '${skillName}' is a broken symlink.`);
    }

    await moveDirectory(codexEntry.realPath, destinationPath);
    await removePath(codexEntry.path);
  } else {
    await moveDirectory(codexEntry.path, destinationPath);
  }

  const refreshedEntries = await findSkillEntries(paths, skillName);
  if (!refreshedEntries.sharedEntry) {
    throw new Error(`Skill '${skillName}' could not be materialized in the shared directory.`);
  }

  return {
    codexEntry: refreshedEntries.codexEntry,
    sharedEntry: refreshedEntries.sharedEntry,
  };
}

export async function getSharedSkillsState(
  input: SharedSkillsConfigInput,
): Promise<SharedSkillsState> {
  const paths = resolveSharedSkillsPaths(input);
  return withSharedSkillsLock(paths, async () => {
    const marker = await readInitializationMarker(paths);
    const disabledSkillNames = new Set(marker?.disabledSkillNames ?? []);
    const warnings = marker
      ? await reconcileSharedSkills(paths, disabledSkillNames, {
          migrateDiscoveredSkills: false,
        })
      : [];

    if (marker) {
      await writeInitializationMarker(paths, {
        ...marker,
        codexHomePath: paths.codexHomePath,
        disabledSkillNames: [...disabledSkillNames],
      });
    }

    return buildSharedSkillsState(paths, { isInitialized: marker !== null, warnings });
  });
}

export async function initializeSharedSkills(
  input: SharedSkillsConfigInput,
): Promise<SharedSkillsState> {
  const paths = resolveSharedSkillsPaths(input);
  return withSharedSkillsLock(paths, async () => {
    await fs.mkdir(paths.sharedSkillsPath, { recursive: true });
    const warnings = await reconcileSharedSkills(paths, new Set(), {
      migrateDiscoveredSkills: true,
    });
    await writeInitializationMarker(paths, {
      version: 1,
      initializedAt: new Date().toISOString(),
      codexHomePath: paths.codexHomePath,
      disabledSkillNames: [],
    });
    return buildSharedSkillsState(paths, { isInitialized: true, warnings });
  });
}

export async function getSharedSkillDetail(
  input: SharedSkillDetailInput,
): Promise<SharedSkillDetail> {
  const paths = resolveSharedSkillsPaths(input);
  const { codexEntry, sharedEntry } = await findSkillEntries(paths, input.skillName);
  const preferredEntry = sharedEntry ?? codexEntry;
  if (!preferredEntry?.hasSkillMarkdown) {
    throw new Error(`Skill '${input.skillName}' was not found.`);
  }

  const markdown = await readSkillMarkdown(preferredEntry.path);
  if (markdown === null) {
    throw new Error(`Skill '${input.skillName}' could not be read.`);
  }

  return {
    skill: toSharedSkillSummary({
      name: input.skillName,
      paths,
      sharedEntry,
      codexEntry,
    }),
    markdown,
  };
}

export async function setSharedSkillEnabled(
  input: SharedSkillSetEnabledInput,
): Promise<SharedSkillsState> {
  const paths = resolveSharedSkillsPaths(input);
  return withSharedSkillsLock(paths, async () => {
    const marker = await readInitializationMarker(paths);
    if (!marker) {
      throw new Error("Initialize shared skills before changing whether a skill is enabled.");
    }

    const disabledSkillNames = new Set(marker.disabledSkillNames);
    await Promise.all([
      fs.mkdir(paths.codexSkillsPath, { recursive: true }),
      fs.mkdir(paths.agentsSkillsPath, { recursive: true }),
      fs.mkdir(paths.sharedSkillsPath, { recursive: true }),
    ]);

    const { codexEntry, sharedEntry } = await ensureSharedSkillMaterialized(paths, input.skillName);
    const sharedSkillPath = sharedEntry.path;
    const codexSkillPath = codexEntry?.path ?? preferredHarnessSkillPath(paths, input.skillName);

    if (input.enabled) {
      if (codexEntry?.isSymlink) {
        if (
          codexEntry.realPath !== null &&
          sharedEntry?.realPath !== null &&
          codexEntry.realPath === sharedEntry.realPath
        ) {
          disabledSkillNames.delete(input.skillName);
          await writeInitializationMarker(paths, {
            ...marker,
            codexHomePath: paths.codexHomePath,
            disabledSkillNames: [...disabledSkillNames],
          });
          return buildSharedSkillsState(paths, { isInitialized: true, warnings: [] });
        }

        await removePath(codexEntry.path);
        const containingRoot = containingHarnessRoot(paths, codexEntry.path);
        if (containingRoot) {
          await removeEmptyParentDirectories(containingRoot, codexEntry.path);
        }
      } else if (codexEntry) {
        throw new Error(
          `Skill '${input.skillName}' could not be enabled because Codex still owns a real directory at '${codexSkillPath}'.`,
        );
      }

      await createDirectorySymlink(sharedSkillPath, codexSkillPath);
      disabledSkillNames.delete(input.skillName);
      await writeInitializationMarker(paths, {
        ...marker,
        codexHomePath: paths.codexHomePath,
        disabledSkillNames: [...disabledSkillNames],
      });
      return buildSharedSkillsState(paths, { isInitialized: true, warnings: [] });
    }

    if (codexEntry?.isSymlink) {
      await removePath(codexEntry.path);
      const containingRoot = containingHarnessRoot(paths, codexEntry.path);
      if (containingRoot) {
        await removeEmptyParentDirectories(containingRoot, codexEntry.path);
      }
    } else if (codexEntry) {
      throw new Error(
        `Skill '${input.skillName}' could not be disabled because Codex still owns a real directory at '${codexSkillPath}'.`,
      );
    }

    disabledSkillNames.add(input.skillName);
    await writeInitializationMarker(paths, {
      ...marker,
      codexHomePath: paths.codexHomePath,
      disabledSkillNames: [...disabledSkillNames],
    });
    return buildSharedSkillsState(paths, { isInitialized: true, warnings: [] });
  });
}

export async function uninstallSharedSkill(
  input: SharedSkillUninstallInput,
): Promise<SharedSkillsState> {
  const paths = resolveSharedSkillsPaths(input);
  return withSharedSkillsLock(paths, async () => {
    const marker = await readInitializationMarker(paths);
    const { codexEntry, sharedEntry } = await findSkillEntries(paths, input.skillName);

    if (codexEntry?.isSymlink) {
      await removePath(codexEntry.path);
      const containingRoot = containingHarnessRoot(paths, codexEntry.path);
      if (containingRoot) {
        await removeEmptyParentDirectories(containingRoot, codexEntry.path);
      }
    } else if (codexEntry) {
      await removePath(codexEntry.path);
      const containingRoot = containingHarnessRoot(paths, codexEntry.path);
      if (containingRoot) {
        await removeEmptyParentDirectories(containingRoot, codexEntry.path);
      }
    }

    if (sharedEntry) {
      await removePath(sharedEntry.path);
      await removeEmptyParentDirectories(paths.sharedSkillsPath, sharedEntry.path);
    }

    if (marker) {
      const disabledSkillNames = new Set(marker.disabledSkillNames);
      disabledSkillNames.delete(input.skillName);
      await writeInitializationMarker(paths, {
        ...marker,
        codexHomePath: paths.codexHomePath,
        disabledSkillNames: [...disabledSkillNames],
      });
    }

    return buildSharedSkillsState(paths, {
      isInitialized: marker !== null,
      warnings: [],
    });
  });
}

export { SHARED_SKILLS_MARKER_FILE };
