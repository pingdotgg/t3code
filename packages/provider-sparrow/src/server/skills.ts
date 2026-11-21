import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import {
  COMPACT_SLASH_COMMAND,
  nonEmptyTrimmed,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { SparrowSettings } from "../settings.ts";
import { resolveSparrowProcessEnvironment } from "./acpSupport.ts";

const MAX_SCAN_DEPTH = 4;

interface ParsedFrontmatter {
  readonly name?: string;
  readonly description?: string;
}

function unquoteScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseMarkdownFrontmatter(text: string): ParsedFrontmatter {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  let name: string | undefined;
  let description: string | undefined;
  for (let i = 1; i < lines.length && i < 64; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") break;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = unquoteScalar(line.slice(colon + 1));
    if (!value) continue;
    if (key === "name" && !name) name = value;
    if (key === "description" && !description) description = value;
  }
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

const skipMissingOrUnreadable = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<A | undefined, never, R> =>
  effect.pipe(Effect.catchTags({ PlatformError: () => Effect.undefined }));

const discoverProjectAncestors = Effect.fn("SparrowSkills.discoverProjectAncestors")(function* (
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dirs: Array<string> = [];
  let current = cwd;
  for (;;) {
    dirs.push(current);
    const hasGit = yield* Effect.option(fileSystem.stat(path.join(current, ".git"))).pipe(
      Effect.map(Option.isSome),
    );
    if (hasGit) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
});

const scanSkillDirectory = Effect.fn("SparrowSkills.scanSkillDirectory")(function* (input: {
  readonly root: string;
  readonly scope: "user" | "project";
  readonly depth?: number;
}): Effect.fn.Return<
  ReadonlyArray<{ readonly folder: string; readonly skill: ServerProviderSkill }>,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const depth = input.depth ?? 0;
  if (depth > MAX_SCAN_DEPTH) return [];
  const entries = yield* skipMissingOrUnreadable(fileSystem.readDirectory(input.root));
  if (!entries) return [];

  const results: Array<{ readonly folder: string; readonly skill: ServerProviderSkill }> = [];
  for (const entry of [...entries].toSorted()) {
    const entryPath = path.join(input.root, entry);
    const info = yield* skipMissingOrUnreadable(fileSystem.stat(entryPath));
    if (!info) continue;

    if (info.type === "Directory") {
      const skillFile = path.join(entryPath, "SKILL.md");
      const skillStat = yield* skipMissingOrUnreadable(fileSystem.stat(skillFile));
      if (skillStat?.type === "File") {
        const content = yield* skipMissingOrUnreadable(fileSystem.readFileString(skillFile));
        const meta = content ? parseMarkdownFrontmatter(content) : {};
        const name = nonEmptyTrimmed(meta.name) ?? entry;
        const folder =
          (yield* skipMissingOrUnreadable(fileSystem.realPath(entryPath))) ?? entryPath;
        results.push({
          folder,
          skill: {
            name,
            path: skillFile,
            scope: input.scope,
            enabled: true,
            ...(meta.description ? { description: meta.description } : {}),
          },
        });
      } else {
        results.push(
          ...(yield* scanSkillDirectory({
            root: entryPath,
            scope: input.scope,
            depth: depth + 1,
          })),
        );
      }
      continue;
    }

    if (info.type === "File" && entry.toLowerCase().endsWith(".md") && entry !== "SKILL.md") {
      const content = yield* skipMissingOrUnreadable(fileSystem.readFileString(entryPath));
      if (!content) continue;
      const meta = parseMarkdownFrontmatter(content);
      if (!meta.name && !meta.description) continue;
      const real = (yield* skipMissingOrUnreadable(fileSystem.realPath(entryPath))) ?? entryPath;
      results.push({
        folder: real,
        skill: {
          name: nonEmptyTrimmed(meta.name) ?? path.basename(entry, path.extname(entry)),
          path: entryPath,
          scope: input.scope,
          enabled: true,
          ...(meta.description ? { description: meta.description } : {}),
        },
      });
    }
  }
  return results;
});

function resolveHome(environment: NodeJS.ProcessEnv): string | undefined {
  return nonEmptyTrimmed(environment.HOME) ?? nonEmptyTrimmed(environment.USERPROFILE);
}

/**
 * Discovers Sparrow skills across project `.sparrow/skills` & `.agents/skills` ancestors
 * and user `~/.config/sparrow/skills` & `~/.agents/skills`, matching Sparrow's loader order.
 */
export const discoverSparrowSkills = Effect.fn("discoverSparrowSkills")(function* (input: {
  readonly cwd?: string;
  readonly settings?: Pick<SparrowSettings, "homePath">;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const env =
    resolveSparrowProcessEnvironment(input.settings, input.environment) ?? input.environment;
  const home = resolveHome(env);

  const roots: Array<{ readonly root: string; readonly scope: "user" | "project" }> = [];
  if (input.cwd) {
    const resolvedCwd =
      (yield* skipMissingOrUnreadable(fileSystem.realPath(input.cwd))) ?? input.cwd;
    for (const dir of yield* discoverProjectAncestors(resolvedCwd)) {
      roots.push(
        { root: path.join(dir, ".sparrow", "skills"), scope: "project" },
        { root: path.join(dir, ".agents", "skills"), scope: "project" },
      );
    }
  }
  if (home) {
    roots.push(
      { root: path.join(home, ".config", "sparrow", "skills"), scope: "user" },
      { root: path.join(home, ".agents", "skills"), scope: "user" },
    );
  }

  const seenFolders = new Set<string>();
  const seenNames = new Set<string>();
  const discovered: Array<ServerProviderSkill> = [];
  for (const root of roots) {
    for (const { folder, skill } of yield* scanSkillDirectory(root)) {
      if (seenFolders.has(folder) || seenNames.has(skill.name)) continue;
      seenFolders.add(folder);
      seenNames.add(skill.name);
      discovered.push(skill);
    }
  }
  return discovered;
});

export const discoverSparrowSlashCommands = Effect.fn("discoverSparrowSlashCommands")(
  function* (input: {
    readonly cwd?: string;
    readonly settings?: Pick<SparrowSettings, "homePath">;
    readonly environment: NodeJS.ProcessEnv;
  }): Effect.fn.Return<
    ReadonlyArray<ServerProviderSlashCommand>,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env =
      resolveSparrowProcessEnvironment(input.settings, input.environment) ?? input.environment;
    const home = resolveHome(env);

    const promptDirs: Array<string> = [];
    if (input.cwd) promptDirs.push(path.join(input.cwd, ".sparrow", "prompts"));
    if (home) promptDirs.push(path.join(home, ".config", "sparrow", "prompts"));

    const seenNames = new Set<string>(["compact"]);
    const commands: Array<ServerProviderSlashCommand> = [COMPACT_SLASH_COMMAND];

    for (const dir of promptDirs) {
      const entries = yield* skipMissingOrUnreadable(fileSystem.readDirectory(dir));
      if (!entries) continue;
      for (const entry of [...entries].toSorted()) {
        if (!entry.toLowerCase().endsWith(".md")) continue;
        const fullPath = path.join(dir, entry);
        const info = yield* skipMissingOrUnreadable(fileSystem.stat(fullPath));
        if (info?.type !== "File") continue;
        const name = entry.slice(0, -3).trim();
        if (!name || seenNames.has(name)) continue;
        seenNames.add(name);
        const content = yield* skipMissingOrUnreadable(fileSystem.readFileString(fullPath));
        const meta = content ? parseMarkdownFrontmatter(content) : {};
        commands.push({
          name,
          description: nonEmptyTrimmed(meta.description) ?? `Run Sparrow prompt '${name}'`,
        });
      }
    }
    return commands;
  },
);
