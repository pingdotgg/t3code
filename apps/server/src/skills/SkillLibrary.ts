import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type SkillBundle,
  type SkillBundleFile,
  type SkillInjectInput,
  type SkillInjectItemResult,
  type SkillInjectResult,
  type SkillInjectTarget,
  type SkillLibraryEntry,
  SkillLibraryError,
  type SkillLibraryListInput,
  type SkillLibraryListResult,
  type SkillLibraryReadBundleInput,
  type SkillLibraryReadBundleResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { parse as parseYamlDocument } from "yaml";

const MAX_SKILL_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_SKILL = 200;
const SKIPPED_DIR_NAMES = new Set([".git", "node_modules", "__pycache__"]);
const SAFE_SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function expandHomeDir(rawPath: string, homeDir: string): string {
  if (rawPath === "~") return homeDir;
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return NodePath.join(homeDir, rawPath.slice(2));
  }
  return rawPath;
}

function resolveSkillLibraryPath(libraryPath: string | undefined, homeDir: string): string {
  const trimmed = libraryPath?.trim();
  if (!trimmed) {
    return NodePath.join(homeDir, ".t3", "skills");
  }
  return NodePath.resolve(expandHomeDir(trimmed, homeDir));
}

export function resolveSkillInjectTargetDirectory(
  target: SkillInjectTarget,
  homeDir: string,
): string {
  switch (target) {
    case "agents":
      return NodePath.join(homeDir, ".agents", "skills");
    case "codex":
      return NodePath.join(homeDir, ".codex", "skills");
    case "claude":
      return NodePath.join(homeDir, ".claude", "skills");
    case "antigravity":
      return NodePath.join(homeDir, ".gemini", "config", "skills");
    case "pi":
      return NodePath.join(homeDir, ".pi", "agent", "skills");
  }
}

export function assertSafeSkillName(name: string): string {
  const trimmed = name.trim();
  if (!SAFE_SKILL_NAME_PATTERN.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new SkillLibraryError({
      message: `Invalid skill name '${name}'. Use letters, digits, '.', '_' or '-'.`,
    });
  }
  return trimmed;
}

export function assertSafeRelativePath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new SkillLibraryError({
      message: `Invalid skill file path '${relativePath}'.`,
    });
  }
  return normalized;
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match?.[1]) return {};
  try {
    const parsed = parseYamlDocument(match[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : undefined;
      const description =
        typeof record.description === "string" ? record.description.trim() : undefined;
      return {
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
      };
    }
  } catch {
    // Ignore malformed frontmatter and fall back to folder name.
  }
  return {};
}

async function collectSkillFiles(
  skillRoot: string,
  includeContents: boolean,
): Promise<{
  readonly files: Array<SkillBundleFile>;
  readonly filesCount: number;
  readonly totalBytes: number;
}> {
  const files: Array<SkillBundleFile> = [];
  let filesCount = 0;
  let totalBytes = 0;

  const walk = async (dirPath: string, relativePrefix: string): Promise<void> => {
    const entries = await NodeFSP.readdir(dirPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory() && SKIPPED_DIR_NAMES.has(entry.name)) {
        continue;
      }
      const entryPath = NodePath.join(dirPath, entry.name);
      const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      const stat = entry.isSymbolicLink() ? await NodeFSP.stat(entryPath) : null;
      const isDir = entry.isDirectory() || (stat?.isDirectory() ?? false);
      const isFile = entry.isFile() || (stat?.isFile() ?? false);
      if (isDir) {
        await walk(entryPath, relPath);
      } else if (isFile) {
        filesCount += 1;
        if (filesCount > MAX_FILES_PER_SKILL) {
          throw new SkillLibraryError({
            message: `Skill at '${skillRoot}' exceeds the maximum of ${MAX_FILES_PER_SKILL} files.`,
          });
        }
        const fileStat = stat ?? (await NodeFSP.stat(entryPath));
        totalBytes += fileStat.size;
        if (totalBytes > MAX_SKILL_BYTES) {
          throw new SkillLibraryError({
            message: `Skill at '${skillRoot}' exceeds the ${MAX_SKILL_BYTES} byte size limit.`,
          });
        }
        if (includeContents) {
          const data = await NodeFSP.readFile(entryPath);
          files.push({
            relativePath: relPath,
            contentBase64: data.toString("base64"),
          });
        }
      }
    }
  };

  await walk(skillRoot, "");
  return { files, filesCount, totalBytes };
}

export const listSkillLibrary = Effect.fn("SkillLibrary.list")(function* (
  input: SkillLibraryListInput,
): Effect.fn.Return<SkillLibraryListResult, SkillLibraryError> {
  const homeDir = yield* HostProcess.HomeDirectory;
  const libraryPath = resolveSkillLibraryPath(input.libraryPath, homeDir);

  return yield* Effect.tryPromise({
    try: async () => {
      let entries;
      try {
        entries = await NodeFSP.readdir(libraryPath, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") {
          return { libraryPath, exists: false, skills: [] };
        }
        throw error;
      }

      entries.sort((a, b) => a.name.localeCompare(b.name));
      const skills: Array<SkillLibraryEntry> = [];
      for (const entry of entries) {
        if (!SAFE_SKILL_NAME_PATTERN.test(entry.name)) continue;
        const entryPath = NodePath.join(libraryPath, entry.name);
        let isDir = entry.isDirectory();
        if (!isDir && entry.isSymbolicLink()) {
          try {
            isDir = (await NodeFSP.stat(entryPath)).isDirectory();
          } catch {
            isDir = false;
          }
        }
        if (!isDir) continue;
        const skillMdPath = NodePath.join(entryPath, "SKILL.md");
        let skillMdContent: string;
        try {
          skillMdContent = await NodeFSP.readFile(skillMdPath, "utf8");
        } catch {
          continue;
        }
        const meta = parseSkillFrontmatter(skillMdContent);
        const stats = await collectSkillFiles(entryPath, false);
        skills.push({
          name: entry.name,
          ...(meta.description ? { description: meta.description } : {}),
          relativePath: entry.name,
          filesCount: stats.filesCount,
          totalBytes: stats.totalBytes,
        });
      }

      return { libraryPath, exists: true, skills };
    },
    catch: (cause) =>
      cause instanceof SkillLibraryError
        ? cause
        : new SkillLibraryError({
            message: `Failed to read skill library at '${libraryPath}'.`,
            cause,
          }),
  });
});

export const readSkillLibraryBundle = Effect.fn("SkillLibrary.readBundle")(function* (
  input: SkillLibraryReadBundleInput,
): Effect.fn.Return<SkillLibraryReadBundleResult, SkillLibraryError> {
  const homeDir = yield* HostProcess.HomeDirectory;
  const libraryPath = resolveSkillLibraryPath(input.libraryPath, homeDir);

  return yield* Effect.tryPromise({
    try: async () => {
      const skills: Array<SkillBundle> = [];
      let bundleBytes = 0;

      for (const rawName of input.names) {
        const name = assertSafeSkillName(rawName);
        const skillRoot = NodePath.join(libraryPath, name);
        const skillMdPath = NodePath.join(skillRoot, "SKILL.md");
        try {
          await NodeFSP.access(skillMdPath);
        } catch {
          throw new SkillLibraryError({
            message: `Skill '${name}' was not found in '${libraryPath}'.`,
          });
        }
        const collected = await collectSkillFiles(skillRoot, true);
        bundleBytes += collected.totalBytes;
        if (bundleBytes > MAX_BUNDLE_BYTES) {
          throw new SkillLibraryError({
            message: `Selected skills exceed the ${MAX_BUNDLE_BYTES} byte transfer limit.`,
          });
        }
        skills.push({ name, files: collected.files });
      }

      return { libraryPath, skills };
    },
    catch: (cause) =>
      cause instanceof SkillLibraryError
        ? cause
        : new SkillLibraryError({
            message: `Failed to read skills from '${libraryPath}'.`,
            cause,
          }),
  });
});

export const injectSkills = Effect.fn("SkillLibrary.inject")(function* (
  input: SkillInjectInput,
): Effect.fn.Return<SkillInjectResult, SkillLibraryError> {
  const homeDir = yield* HostProcess.HomeDirectory;
  const overwrite = input.overwrite ?? true;

  return yield* Effect.tryPromise({
    try: async () => {
      const results: Array<SkillInjectItemResult> = [];
      const uniqueTargets = [...new Set(input.targets)];

      for (const skill of input.skills) {
        const safeName = assertSafeSkillName(skill.name);
        const validatedFiles = skill.files.map((file) => ({
          relativePath: assertSafeRelativePath(file.relativePath),
          data: Buffer.from(file.contentBase64, "base64"),
        }));

        for (const target of uniqueTargets) {
          const targetBase = resolveSkillInjectTargetDirectory(target, homeDir);
          const destinationPath = NodePath.join(targetBase, safeName);
          try {
            let exists = false;
            try {
              await NodeFSP.lstat(destinationPath);
              exists = true;
            } catch {
              exists = false;
            }
            if (exists && !overwrite) {
              results.push({
                skillName: safeName,
                target,
                destinationPath,
                status: "skipped",
                message: "Already exists and overwrite is disabled.",
              });
              continue;
            }
            if (exists) {
              await NodeFSP.rm(destinationPath, { recursive: true, force: true });
            }
            await NodeFSP.mkdir(destinationPath, { recursive: true });
            for (const file of validatedFiles) {
              const outPath = NodePath.join(destinationPath, ...file.relativePath.split("/"));
              await NodeFSP.mkdir(NodePath.dirname(outPath), { recursive: true });
              await NodeFSP.writeFile(outPath, file.data);
            }
            results.push({
              skillName: safeName,
              target,
              destinationPath,
              status: "injected",
            });
          } catch (error) {
            results.push({
              skillName: safeName,
              target,
              destinationPath,
              status: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      return { results };
    },
    catch: (cause) =>
      cause instanceof SkillLibraryError
        ? cause
        : new SkillLibraryError({
            message: "Failed to inject skills.",
            cause,
          }),
  });
});
