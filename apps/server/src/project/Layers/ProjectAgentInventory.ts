import * as fsPromises from "node:fs/promises";

import type {
  ServerLocalAgentCommand,
  ServerLocalAgentInventory,
  ServerLocalAgentSkill,
} from "@forma/contracts";
import { Cache, Duration, Effect, Exit, Layer, Path } from "effect";
import {
  parseLocalAgentCommandJsonDocument,
  parseLocalAgentCommandMarkdownDocument,
  parseLocalAgentSkillDocument,
} from "@forma/shared/localAgents";

import {
  ProjectAgentInventory,
  type ProjectAgentInventoryShape,
} from "../Services/ProjectAgentInventory.ts";

const DEFAULT_AGENT_INVENTORY_CACHE_CAPACITY = 16;
const DEFAULT_AGENT_INVENTORY_CACHE_TTL = Duration.seconds(10);

const EMPTY_LOCAL_AGENT_INVENTORY: ServerLocalAgentInventory = {
  skills: [],
  commands: [],
};

interface InventoryWarning {
  readonly context: Record<string, unknown>;
  readonly message: string;
}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

function toWarningDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await fsPromises.stat(pathValue);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursively(root: string): Promise<string[]> {
  const entries = await fsPromises.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(fullPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function commandCandidateWeight(pathValue: string): number {
  if (pathValue.endsWith("/command.json")) {
    return 0;
  }
  return 1;
}

function sortRelativePaths(left: string, right: string): number {
  const weightDelta = commandCandidateWeight(left) - commandCandidateWeight(right);
  if (weightDelta !== 0) {
    return weightDelta;
  }
  return left.localeCompare(right);
}

function defaultSkillNameFromRelativePath(relativePath: string): string {
  const segments = toPosixPath(relativePath).split("/");
  return segments.at(-2) ?? "skill";
}

function defaultCommandNameFromRelativePath(relativePath: string): string {
  const normalizedPath = toPosixPath(relativePath);
  if (normalizedPath.endsWith("/command.json")) {
    const segments = normalizedPath.split("/");
    return segments.at(-2) ?? "command";
  }
  const basename = normalizedPath.split("/").at(-1) ?? "command.md";
  return basename.replace(/\.md$/i, "") || "command";
}

function dedupeItemsByName<T extends { readonly name: string; readonly path: string }>(
  items: ReadonlyArray<T>,
  kind: "skill" | "command",
): {
  readonly items: ReadonlyArray<T>;
  readonly warnings: ReadonlyArray<InventoryWarning>;
} {
  const deduped = new Map<string, T>();
  const warnings: InventoryWarning[] = [];

  for (const item of items) {
    const existing = deduped.get(item.name);
    if (!existing) {
      deduped.set(item.name, item);
      continue;
    }

    warnings.push({
      message: `duplicate project-local ${kind} ignored`,
      context: {
        name: item.name,
        keptPath: existing.path,
        ignoredPath: item.path,
      },
    });
  }

  return {
    items: [...deduped.values()],
    warnings,
  };
}

async function readSkillFile(input: {
  readonly normalizedRoot: string;
  readonly path: Path.Path;
  readonly relativePath: string;
}): Promise<{
  readonly item: ServerLocalAgentSkill | null;
  readonly warnings: ReadonlyArray<InventoryWarning>;
}> {
  try {
    const contents = await fsPromises.readFile(
      input.path.join(input.normalizedRoot, input.relativePath),
      "utf8",
    );
    return {
      item: parseLocalAgentSkillDocument({
        contents,
        defaultName: defaultSkillNameFromRelativePath(input.relativePath),
        path: input.relativePath,
      }).skill,
      warnings: [],
    };
  } catch (error) {
    return {
      item: null,
      warnings: [
        {
          message: "failed to parse project-local skill",
          context: {
            path: input.relativePath,
            detail: toWarningDetail(error),
          },
        },
      ],
    };
  }
}

async function readCommandFile(input: {
  readonly normalizedRoot: string;
  readonly path: Path.Path;
  readonly relativePath: string;
}): Promise<{
  readonly item: ServerLocalAgentCommand | null;
  readonly warnings: ReadonlyArray<InventoryWarning>;
}> {
  try {
    const contents = await fsPromises.readFile(
      input.path.join(input.normalizedRoot, input.relativePath),
      "utf8",
    );
    return {
      item: input.relativePath.endsWith("/command.json")
        ? parseLocalAgentCommandJsonDocument({
            contents,
            defaultName: defaultCommandNameFromRelativePath(input.relativePath),
            path: input.relativePath,
          }).command
        : parseLocalAgentCommandMarkdownDocument({
            contents,
            defaultName: defaultCommandNameFromRelativePath(input.relativePath),
            path: input.relativePath,
          }).command,
      warnings: [],
    };
  } catch (error) {
    return {
      item: null,
      warnings: [
        {
          message: "failed to parse project-local command",
          context: {
            path: input.relativePath,
            detail: toWarningDetail(error),
          },
        },
      ],
    };
  }
}

async function readInventoryFromDisk(input: {
  readonly cwd: string;
  readonly path: Path.Path;
}): Promise<{
  readonly inventory: ServerLocalAgentInventory;
  readonly warnings: ReadonlyArray<InventoryWarning>;
}> {
  const normalizedRoot = input.path.resolve(input.cwd);
  const agentsRoot = input.path.join(normalizedRoot, ".agents");

  try {
    if (!(await pathExists(agentsRoot))) {
      return {
        inventory: EMPTY_LOCAL_AGENT_INVENTORY,
        warnings: [],
      };
    }

    const skillsRoot = input.path.join(agentsRoot, "skills");
    const commandsRoot = input.path.join(agentsRoot, "commands");
    const [skillFiles, commandFiles] = await Promise.all([
      pathExists(skillsRoot).then((exists) =>
        exists
          ? listFilesRecursively(skillsRoot).then((entries) =>
              entries
                .map((entry) => toPosixPath(input.path.relative(normalizedRoot, entry)))
                .filter(
                  (entry) => entry.endsWith("/SKILL.md") || entry === ".agents/skills/SKILL.md",
                )
                .toSorted((left, right) => left.localeCompare(right)),
            )
          : [],
      ),
      pathExists(commandsRoot).then((exists) =>
        exists
          ? listFilesRecursively(commandsRoot).then((entries) =>
              entries
                .map((entry) => toPosixPath(input.path.relative(normalizedRoot, entry)))
                .filter((entry) => entry.endsWith(".md") || entry.endsWith("/command.json"))
                .toSorted(sortRelativePaths),
            )
          : [],
      ),
    ]);

    const [skillResults, commandResults] = await Promise.all([
      Promise.all(
        skillFiles.map((relativePath) =>
          readSkillFile({ normalizedRoot, path: input.path, relativePath }),
        ),
      ),
      Promise.all(
        commandFiles.map((relativePath) =>
          readCommandFile({ normalizedRoot, path: input.path, relativePath }),
        ),
      ),
    ]);

    const parsedSkills = skillResults.flatMap((result) => (result.item ? [result.item] : []));
    const parsedCommands = commandResults.flatMap((result) => (result.item ? [result.item] : []));
    const dedupedSkills = dedupeItemsByName(parsedSkills, "skill");
    const dedupedCommands = dedupeItemsByName(parsedCommands, "command");

    return {
      inventory: {
        skills: dedupedSkills.items,
        commands: dedupedCommands.items,
      },
      warnings: [
        ...skillResults.flatMap((result) => result.warnings),
        ...commandResults.flatMap((result) => result.warnings),
        ...dedupedSkills.warnings,
        ...dedupedCommands.warnings,
      ],
    };
  } catch (error) {
    return {
      inventory: EMPTY_LOCAL_AGENT_INVENTORY,
      warnings: [
        {
          message: "failed to load project-local agent inventory",
          context: {
            cwd: normalizedRoot,
            detail: toWarningDetail(error),
          },
        },
      ],
    };
  }
}

const makeProjectAgentInventory = Effect.gen(function* () {
  const path = yield* Path.Path;

  const readInventoryFromDiskEffect = Effect.fn("ProjectAgentInventory.readInventoryFromDisk")(
    function* (cwd: string) {
      const { inventory, warnings } = yield* Effect.promise(() =>
        readInventoryFromDisk({ cwd, path }),
      );
      yield* Effect.forEach(
        warnings,
        (warning) => Effect.logWarning(warning.message, warning.context),
        {
          discard: true,
        },
      );
      return inventory;
    },
  );

  const inventoryCache = yield* Cache.makeWith<string, ServerLocalAgentInventory>(
    (cwd) => readInventoryFromDiskEffect(cwd),
    {
      capacity: DEFAULT_AGENT_INVENTORY_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: () => DEFAULT_AGENT_INVENTORY_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );

  const getInventory: ProjectAgentInventoryShape["getInventory"] = Effect.fn(
    "ProjectAgentInventory.getInventory",
  )(function* (cwd) {
    return yield* Cache.get(inventoryCache, path.resolve(cwd));
  });

  const invalidate: ProjectAgentInventoryShape["invalidate"] = Effect.fn(
    "ProjectAgentInventory.invalidate",
  )(function* (cwd) {
    yield* Cache.invalidate(inventoryCache, path.resolve(cwd));
  });

  return {
    getInventory,
    invalidate,
  } satisfies ProjectAgentInventoryShape;
});

export const ProjectAgentInventoryLive = Layer.effect(
  ProjectAgentInventory,
  makeProjectAgentInventory,
);
