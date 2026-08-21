/**
 * Grok skill and slash-command discovery for the `$` and `/` pickers.
 *
 * Prefer the harness: `grok inspect --json` is the inventory Grok itself
 * loads (bundled, user, project, plugin, config), and ACP
 * `available_commands_update` is the live `/` menu (built-in features plus
 * user-invocable skills). Filesystem scanning of `.grok/skills`,
 * `.claude/skills`, and `.agents/skills` is the fallback when inspect is
 * unavailable.
 *
 * `cwd` may be one path or many (registered project roots + worktrees).
 * Project skills are tagged with that workspace's `sourceCwd`.
 *
 * @module provider/Drivers/GrokSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
import { normalizeProviderSkillWorkspacePath } from "@t3tools/shared/providerSkills";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { spawnAndCollect } from "../providerSnapshot.ts";
import {
  discoverSkillsFromRoots,
  listAncestorPaths,
  normalizeSkillWorkspaceCwds,
  resolveGitRootPath,
  type SkillDiscoveryRoot,
} from "./SkillDiscovery.ts";

const GROK_USER_SKILL_DIR_NAMES = [".claude", ".agents", ".grok"] as const;
const GROK_PROJECT_SKILL_DIR_NAMES = [".claude", ".agents", ".grok"] as const;

function skillRootsForDir(
  pathApi: Path.Path,
  dir: string,
  scope: SkillDiscoveryRoot["scope"],
  sourceCwd?: string,
): SkillDiscoveryRoot[] {
  const names = scope === "user" ? GROK_USER_SKILL_DIR_NAMES : GROK_PROJECT_SKILL_DIR_NAMES;
  return names.map((name) => ({
    directory: pathApi.join(dir, name, "skills"),
    scope,
    ...(sourceCwd ? { sourceCwd } : {}),
  }));
}

export const discoverGrokSkills = Effect.fn("discoverGrokSkills")(function* (
  cwd: string | ReadonlyArray<string>,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const home = NodeOS.homedir();
  const projectCwds = normalizeSkillWorkspaceCwds(path, cwd);

  // User roots first (compat → native), then project ancestors for each workspace.
  const roots: SkillDiscoveryRoot[] = [...skillRootsForDir(path, home, "user")];

  for (const projectCwd of projectCwds) {
    const gitRoot = yield* resolveGitRootPath(projectCwd);
    roots.push(
      ...listAncestorPaths(path, projectCwd, gitRoot).flatMap((dir) =>
        skillRootsForDir(path, dir, "project", projectCwd),
      ),
    );
  }

  return yield* discoverSkillsFromRoots(roots);
});

const GROK_INSPECT_TIMEOUT_MS = 4_000;
const GROK_PROJECT_SKILL_SOURCE_TYPES = new Set(["project", "local", "repo"]);

const ignoreExcessProperties = { parseOptions: { onExcessProperty: "ignore" as const } };

const GrokInspectSkillSource = Schema.Struct({
  type: Schema.String,
  path: Schema.optional(Schema.String),
}).annotate(ignoreExcessProperties);

const GrokInspectSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  source: GrokInspectSkillSource,
  userInvocable: Schema.optional(Schema.Boolean),
  invocableAs: Schema.optional(Schema.String),
}).annotate(ignoreExcessProperties);

const GrokInspectReport = Schema.Struct({
  skills: Schema.Array(GrokInspectSkill),
}).annotate(ignoreExcessProperties);

const decodeGrokInspectReport = Schema.decodeUnknownEffect(GrokInspectReport);
const decodeGrokInspectReportExit = Schema.decodeUnknownExit(GrokInspectReport);

class GrokInspectError extends Schema.TaggedErrorClass<GrokInspectError>()("GrokInspectError", {
  operation: Schema.Literals(["command", "parse"]),
  cwd: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Grok inspect ${this.operation} failed for ${this.cwd}.`;
  }
}

export interface GrokHarnessCatalog {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isGrokProjectSkillSource(sourceType: string): boolean {
  return GROK_PROJECT_SKILL_SOURCE_TYPES.has(sourceType.trim().toLowerCase());
}

function skillInventoryKey(name: string, sourceCwd: string | undefined): string {
  return sourceCwd === undefined ? `user:${name}` : `cwd:${sourceCwd}\0${name}`;
}

function sortGrokSkills(skills: Iterable<ServerProviderSkill>): ServerProviderSkill[] {
  return [...skills].sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    if (byName !== 0) {
      return byName;
    }
    return (left.sourceCwd ?? "").localeCompare(right.sourceCwd ?? "");
  });
}

function parseInspectJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"' && depth > 0) {
        inString = true;
        continue;
      }
      if (character === "{") {
        if (depth === 0) {
          start = index;
        }
        depth += 1;
        continue;
      }
      if (character !== "}" || depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const candidate = JSON.parse(text.slice(start, index + 1));
          if (Exit.isSuccess(decodeGrokInspectReportExit(candidate))) {
            return candidate;
          }
        } catch {
          // Continue scanning later balanced objects in noisy stdout.
        }
        start = -1;
      }
    }
    throw new SyntaxError("Grok inspect output was not JSON.");
  }
}

/**
 * Turn one `grok inspect --json` report into picker inventory.
 *
 * Project / local / repo skills are tagged with `sourceCwd`. Bundled, user,
 * plugin, and config skills stay global. User-invocable skills also become
 * slash commands (`invocableAs` wins when the bare name collides).
 */
export function parseGrokInspectReport(report: unknown, sourceCwd?: string): GrokHarnessCatalog {
  const decoded = decodeGrokInspectReportExit(report);
  if (!Exit.isSuccess(decoded)) {
    return { skills: [], slashCommands: [] };
  }

  const normalizedSourceCwd = sourceCwd?.trim()
    ? normalizeProviderSkillWorkspacePath(sourceCwd.trim())
    : undefined;
  const skillsByKey = new Map<string, ServerProviderSkill>();
  const slashCommandsByName = new Map<string, ServerProviderSlashCommand>();
  const explicitSlashCommandNames = new Set<string>();

  for (const skill of decoded.value.skills) {
    const name = nonEmptyTrimmed(skill.name);
    const skillPath = nonEmptyTrimmed(skill.source.path);
    if (!name || !skillPath) {
      continue;
    }

    const projectScoped = isGrokProjectSkillSource(skill.source.type);
    const skillSourceCwd = projectScoped ? normalizedSourceCwd : undefined;
    const scope = nonEmptyTrimmed(skill.source.type);
    const description = nonEmptyTrimmed(skill.description);

    skillsByKey.set(skillInventoryKey(name, skillSourceCwd), {
      name,
      path: skillPath,
      enabled: true,
      ...(scope ? { scope } : {}),
      ...(skillSourceCwd ? { sourceCwd: skillSourceCwd } : {}),
      ...(description ? { description } : {}),
    });

    if (skill.userInvocable === false) {
      continue;
    }

    const explicitSlashName = nonEmptyTrimmed(skill.invocableAs);
    const slashName = explicitSlashName ?? name;
    const slashKey = slashName.toLowerCase();
    if (!explicitSlashName && explicitSlashCommandNames.has(slashKey)) {
      continue;
    }
    slashCommandsByName.set(slashKey, {
      name: slashName,
      ...(description ? { description } : {}),
    });
    if (explicitSlashName) {
      explicitSlashCommandNames.add(slashKey);
    }
  }

  return {
    skills: sortGrokSkills(skillsByKey.values()),
    slashCommands: [...slashCommandsByName.values()],
  };
}

function grokAvailableCommandSkillMeta(command: EffectAcpSchema.AvailableCommand):
  | {
      readonly path: string;
      readonly scope?: string;
      readonly bareName?: string;
    }
  | undefined {
  const meta = command._meta;
  if (meta === null || meta === undefined || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const path = nonEmptyTrimmed(typeof meta.path === "string" ? meta.path : undefined);
  if (!path) {
    return undefined;
  }
  const scope = nonEmptyTrimmed(typeof meta.scope === "string" ? meta.scope : undefined);
  const bareName = nonEmptyTrimmed(typeof meta.bareName === "string" ? meta.bareName : undefined);
  return {
    path,
    ...(scope ? { scope } : {}),
    ...(bareName ? { bareName } : {}),
  };
}

/**
 * Map an ACP `available_commands_update` into `/` picker commands and `$`
 * picker skills. Commands without a skill path are harness features
 * (`compact`, `deep-research`, …).
 */
export function parseGrokAvailableCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  sourceCwd?: string,
): GrokHarnessCatalog {
  const normalizedSourceCwd = sourceCwd?.trim()
    ? normalizeProviderSkillWorkspacePath(sourceCwd.trim())
    : undefined;
  const slashCommandsByName = new Map<string, ServerProviderSlashCommand>();
  const skillsByKey = new Map<string, ServerProviderSkill>();

  for (const command of commands) {
    const name = nonEmptyTrimmed(command.name);
    if (!name) {
      continue;
    }
    const description = nonEmptyTrimmed(command.description);
    const hint = nonEmptyTrimmed(command.input?.hint);
    const skillMeta = grokAvailableCommandSkillMeta(command);
    const projectScoped = skillMeta?.scope ? isGrokProjectSkillSource(skillMeta.scope) : false;
    const skillSourceCwd = projectScoped ? normalizedSourceCwd : undefined;
    slashCommandsByName.set(name.toLowerCase(), {
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
      ...(skillSourceCwd ? { sourceCwd: skillSourceCwd } : {}),
    });

    if (!skillMeta) {
      continue;
    }
    const skillName = skillMeta.bareName ?? name;
    skillsByKey.set(skillInventoryKey(skillName, skillSourceCwd), {
      name: skillName,
      path: skillMeta.path,
      enabled: true,
      ...(skillMeta.scope ? { scope: skillMeta.scope } : {}),
      ...(skillSourceCwd ? { sourceCwd: skillSourceCwd } : {}),
      ...(description ? { description } : {}),
    });
  }

  return {
    skills: sortGrokSkills(skillsByKey.values()),
    slashCommands: [...slashCommandsByName.values()],
  };
}

export function mergeGrokHarnessCatalogs(
  catalogs: ReadonlyArray<GrokHarnessCatalog>,
): GrokHarnessCatalog {
  const skillsByKey = new Map<string, ServerProviderSkill>();
  const slashCommandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const catalog of catalogs) {
    for (const skill of catalog.skills) {
      skillsByKey.set(skillInventoryKey(skill.name, skill.sourceCwd), skill);
    }
    for (const command of catalog.slashCommands) {
      slashCommandsByName.set(command.name.toLowerCase(), command);
    }
  }

  return {
    skills: sortGrokSkills(skillsByKey.values()),
    slashCommands: [...slashCommandsByName.values()],
  };
}

/**
 * Inspect is the skill authority when the harness returned a report. When
 * inspect is missing, union filesystem skills with any ACP-advertised skills
 * so a single-cwd ACP probe cannot wipe other worktrees. ACP slash commands
 * win when the session advertised a menu.
 */
export function resolveGrokPickerCatalog(input: {
  readonly filesystemSkills: ReadonlyArray<ServerProviderSkill>;
  readonly inspectCatalog?: GrokHarnessCatalog;
  readonly acpCatalog?: GrokHarnessCatalog;
}): GrokHarnessCatalog {
  const skills = input.inspectCatalog
    ? input.inspectCatalog.skills
    : mergeGrokHarnessCatalogs([
        { skills: input.filesystemSkills, slashCommands: [] },
        input.acpCatalog ?? { skills: [], slashCommands: [] },
      ]).skills;
  const slashCommands = input.acpCatalog
    ? input.acpCatalog.slashCommands
    : (input.inspectCatalog?.slashCommands ?? []);
  return { skills, slashCommands };
}

const discoverGrokProjectSkills = Effect.fn("discoverGrokProjectSkills")(function* (
  cwd: string | ReadonlyArray<string>,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const roots: SkillDiscoveryRoot[] = [];
  for (const projectCwd of normalizeSkillWorkspaceCwds(path, cwd)) {
    const gitRoot = yield* resolveGitRootPath(projectCwd);
    roots.push(
      ...listAncestorPaths(path, projectCwd, gitRoot).flatMap((dir) =>
        skillRootsForDir(path, dir, "project", projectCwd),
      ),
    );
  }
  return yield* discoverSkillsFromRoots(roots);
});

const queryGrokInspectAtCwd = Effect.fn("queryGrokInspectAtCwd")(function* (input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const environment = input.environment ?? process.env;
  const spawnCommand = yield* resolveSpawnCommand(input.binaryPath, ["inspect", "--json"], {
    env: environment,
  });
  const result = yield* spawnAndCollect(
    input.binaryPath,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
      cwd: input.cwd,
    }),
  );
  if (result.code !== 0) {
    return yield* new GrokInspectError({
      operation: "command",
      cwd: input.cwd,
      exitCode: result.code,
    });
  }
  const raw = yield* Effect.try({
    try: () => parseInspectJsonObject(result.stdout),
    catch: (cause) => new GrokInspectError({ operation: "parse", cwd: input.cwd, cause }),
  });
  const report = yield* decodeGrokInspectReport(raw).pipe(
    Effect.mapError((cause) => new GrokInspectError({ operation: "parse", cwd: input.cwd, cause })),
  );
  return parseGrokInspectReport(report, input.cwd);
});

/**
 * Ask Grok Build what it would load in each workspace via `grok inspect --json`.
 * Returns `undefined` when every inspect fails so callers can fall back to
 * filesystem discovery.
 */
export const queryGrokInspectCatalog = Effect.fn("queryGrokInspectCatalog")(function* (input: {
  readonly binaryPath: string;
  readonly cwd: string | ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.fn.Return<
  GrokHarnessCatalog | undefined,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  const projectCwds = normalizeSkillWorkspaceCwds(path, input.cwd);
  const inspectCwds = projectCwds.length > 0 ? projectCwds : [path.resolve(process.cwd())];

  const catalogs = yield* Effect.all(
    inspectCwds.map((cwd) =>
      queryGrokInspectAtCwd({
        binaryPath: input.binaryPath,
        cwd,
        ...(input.environment ? { environment: input.environment } : {}),
      }).pipe(
        Effect.timeoutOption(GROK_INSPECT_TIMEOUT_MS),
        Effect.flatMap((result) =>
          Option.match(result, {
            onNone: () => Effect.succeed(undefined),
            onSome: (catalog) => Effect.succeed(catalog),
          }),
        ),
        Effect.catch((error) =>
          Effect.logDebug("Grok inspect catalog query failed.", {
            cwd,
            errorTag: "_tag" in error ? error._tag : "UnknownError",
            ...("_tag" in error && error._tag === "GrokInspectError"
              ? { operation: error.operation }
              : {}),
          }).pipe(Effect.as(undefined)),
        ),
      ),
    ),
    { concurrency: 4 },
  );

  const succeeded: GrokHarnessCatalog[] = [];
  const failedCwds: string[] = [];
  for (const [index, catalog] of catalogs.entries()) {
    if (catalog) {
      succeeded.push(catalog);
    } else {
      const failedCwd = inspectCwds[index];
      if (failedCwd) {
        failedCwds.push(failedCwd);
      }
    }
  }
  if (succeeded.length === 0) {
    return undefined;
  }
  if (failedCwds.length === 0) {
    return mergeGrokHarnessCatalogs(succeeded);
  }
  const fallbackProjectSkills = yield* discoverGrokProjectSkills(failedCwds);
  return mergeGrokHarnessCatalogs([
    { skills: fallbackProjectSkills, slashCommands: [] },
    ...succeeded,
  ]);
});
