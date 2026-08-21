/**
 * OpenCode slash-command discovery for the `/` picker.
 *
 * Prefer the harness. Local installs resolve commands through
 * `opencode debug config` per workspace cwd: its `command` map is the exact
 * inventory the harness loads from `.opencode/command(s)/*.md`,
 * `~/.config/opencode/command(s)/*.md`, and `opencode.json` entries (config
 * walks up from the cwd to the worktree root). Configured external servers
 * are queried through the SDK `command.list` per directory instead, which
 * additionally sees MCP- and plugin-contributed commands.
 *
 * Harness-discovered commands are tagged with each reporting workspace's
 * `sourceCwd` so clients can scope the picker per project (see
 * filterProviderSlashCommandsForWorkspace). The per-workspace inventory does
 * not expose enough provenance to infer that a command is global.
 *
 * Harness built-ins (`init`, `review`) are registered in code rather than
 * config, so neither discovery path is guaranteed to see them; they are
 * merged from a constant.
 *
 * @module provider/Drivers/OpenCodeCommands
 */
import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import { normalizeProviderSkillWorkspacePath } from "@t3tools/shared/providerSkills";
import type { Command as OpenCodeSdkCommand, OpencodeClient } from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { OpenCodeRuntime, runOpenCodeSdk } from "../opencodeRuntime.ts";
import { normalizeSkillWorkspaceCwds } from "./SkillDiscovery.ts";

const OPENCODE_COMMAND_QUERY_CONCURRENCY = 4;

/**
 * Harness built-in commands. Keep in sync with `Command.Default` in the
 * OpenCode source (packages/opencode/src/command/index.ts).
 */
export const OPENCODE_BUILT_IN_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  { name: "init", description: "guided AGENTS.md setup" },
  { name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted" },
];

const ignoreExcessProperties = { parseOptions: { onExcessProperty: "ignore" as const } };

const OpenCodeDebugConfigCommand = Schema.Struct({
  description: Schema.optional(Schema.String),
}).annotate(ignoreExcessProperties);

const OpenCodeDebugConfig = Schema.Struct({
  command: Schema.optional(Schema.Record(Schema.String, OpenCodeDebugConfigCommand)),
}).annotate(ignoreExcessProperties);

const decodeOpenCodeDebugConfigExit = Schema.decodeUnknownExit(OpenCodeDebugConfig);
const decodeOpenCodeDebugConfigStdoutExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(OpenCodeDebugConfig),
);

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function sortSlashCommands(
  commands: Iterable<ServerProviderSlashCommand>,
): ServerProviderSlashCommand[] {
  return [...commands].sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    if (byName !== 0) {
      return byName;
    }
    return (left.sourceCwd ?? "").localeCompare(right.sourceCwd ?? "");
  });
}

function commandsFromDebugConfig(
  config: Schema.Schema.Type<typeof OpenCodeDebugConfig>,
): ServerProviderSlashCommand[] {
  const commands: ServerProviderSlashCommand[] = [];
  for (const [rawName, command] of Object.entries(config.command ?? {})) {
    const name = nonEmptyTrimmed(rawName);
    if (!name) {
      continue;
    }
    const description = nonEmptyTrimmed(command.description);
    commands.push({ name, ...(description ? { description } : {}) });
  }
  return commands;
}

/** Parse the `command` map from one `opencode debug config` report. */
export function parseOpenCodeDebugConfigCommands(
  report: unknown,
): ReadonlyArray<ServerProviderSlashCommand> {
  const decoded = decodeOpenCodeDebugConfigExit(report);
  return Exit.isSuccess(decoded) ? commandsFromDebugConfig(decoded.value) : [];
}

/** Map one SDK `command.list` response. Templates and argument placeholders
 * (`hints` like `$ARGUMENTS`) stay harness-side; the picker only needs the
 * name and description. */
export function parseOpenCodeSdkCommands(
  commands: ReadonlyArray<OpenCodeSdkCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const parsed: ServerProviderSlashCommand[] = [];
  for (const command of commands) {
    const name = nonEmptyTrimmed(command.name);
    if (!name) {
      continue;
    }
    const description = nonEmptyTrimmed(command.description);
    parsed.push({ name, ...(description ? { description } : {}) });
  }
  return parsed;
}

export interface OpenCodeCommandListForCwd {
  readonly cwd: string;
  readonly commands: ReadonlyArray<ServerProviderSlashCommand>;
}

/**
 * Merge per-cwd harness inventories into the picker list. Built-ins are
 * always present and harness entries remain tagged to their workspaces.
 */
export function mergeOpenCodeCommandCwds(
  lists: ReadonlyArray<OpenCodeCommandListForCwd>,
): ServerProviderSlashCommand[] {
  const seenByName = new Map<
    string,
    { readonly command: ServerProviderSlashCommand; readonly cwds: Set<string> }
  >();

  for (const { cwd, commands } of lists) {
    const normalizedCwd = normalizeProviderSkillWorkspacePath(cwd);
    for (const command of commands) {
      const key = command.name.toLowerCase();
      const seen = seenByName.get(key);
      if (seen) {
        seen.cwds.add(normalizedCwd);
      } else {
        seenByName.set(key, { command, cwds: new Set([normalizedCwd]) });
      }
    }
  }

  const merged = new Map<string, ServerProviderSlashCommand>();
  for (const builtIn of OPENCODE_BUILT_IN_SLASH_COMMANDS) {
    merged.set(`global\0${builtIn.name.toLowerCase()}`, builtIn);
  }
  for (const { command, cwds } of seenByName.values()) {
    const key = command.name.toLowerCase();
    for (const sourceCwd of cwds) {
      merged.set(`cwd\0${sourceCwd}\0${key}`, { ...command, sourceCwd });
    }
  }

  return sortSlashCommands(merged.values());
}

/**
 * Ask local OpenCode what it would load in each workspace via
 * `opencode debug config`. Workspaces whose query fails are dropped rather
 * than counted, so a broken cwd cannot demote another project's commands.
 */
export const queryOpenCodeCommandCatalog = Effect.fn("queryOpenCodeCommandCatalog")(
  function* (input: {
    readonly binaryPath: string;
    readonly cwd: string | ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
  }): Effect.fn.Return<
    ReadonlyArray<ServerProviderSlashCommand>,
    never,
    OpenCodeRuntime | Path.Path
  > {
    const path = yield* Path.Path;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const projectCwds = normalizeSkillWorkspaceCwds(path, input.cwd);
    const queryCwds = projectCwds.length > 0 ? projectCwds : [path.resolve(process.cwd())];

    const lists = yield* Effect.all(
      queryCwds.map((cwd) =>
        openCodeRuntime
          .runOpenCodeCommand({
            binaryPath: input.binaryPath,
            args: ["debug", "config"],
            cwd,
            ...(input.environment ? { environment: input.environment } : {}),
          })
          .pipe(
            Effect.map((result) => {
              if (result.code !== 0) {
                return undefined;
              }
              const decoded = decodeOpenCodeDebugConfigStdoutExit(result.stdout);
              return Exit.isSuccess(decoded) ? commandsFromDebugConfig(decoded.value) : undefined;
            }),
            Effect.catch((error) =>
              Effect.logDebug("OpenCode command discovery failed for workspace.", {
                cwd,
                errorTag: error instanceof Error ? error.name : "UnknownError",
              }).pipe(Effect.as(undefined)),
            ),
          ),
      ),
      { concurrency: OPENCODE_COMMAND_QUERY_CONCURRENCY },
    );

    return mergeOpenCodeCommandCwds(
      lists.flatMap((commands, index) => {
        const cwd = queryCwds[index];
        return commands !== undefined && cwd !== undefined ? [{ cwd, commands }] : [];
      }),
    );
  },
);

/**
 * Query a configured OpenCode server for each workspace's `/` menu via the
 * SDK `command.list`. Same merging rule as the local CLI path.
 */
export const queryOpenCodeSdkCommandCatalog = Effect.fn("queryOpenCodeSdkCommandCatalog")(
  function* (input: {
    readonly client: OpencodeClient;
    readonly cwd: string | ReadonlyArray<string>;
  }): Effect.fn.Return<ReadonlyArray<ServerProviderSlashCommand>, never, Path.Path> {
    const path = yield* Path.Path;
    const projectCwds = normalizeSkillWorkspaceCwds(path, input.cwd);
    const queryCwds = projectCwds.length > 0 ? projectCwds : [path.resolve(process.cwd())];

    const lists = yield* Effect.all(
      queryCwds.map((cwd) =>
        runOpenCodeSdk("command.list", () => input.client.command.list({ directory: cwd })).pipe(
          Effect.map((result) => parseOpenCodeSdkCommands(result.data ?? [])),
          Effect.catch((error) =>
            Effect.logDebug("OpenCode server command.list failed for workspace.", {
              cwd,
              errorTag: error instanceof Error ? error.name : "UnknownError",
            }).pipe(Effect.as(undefined)),
          ),
        ),
      ),
      { concurrency: OPENCODE_COMMAND_QUERY_CONCURRENCY },
    );

    return mergeOpenCodeCommandCwds(
      lists.flatMap((commands, index) => {
        const cwd = queryCwds[index];
        return commands !== undefined && cwd !== undefined ? [{ cwd, commands }] : [];
      }),
    );
  },
);
