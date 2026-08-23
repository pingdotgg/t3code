import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

const SCRIPT_BYTE_CAP = 64 * 1024;

export const GROK_WORKFLOW_CONTROL_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  {
    name: "workflow pause",
    description: "Pause the active Grok workflow run",
  },
  {
    name: "workflow resume",
    description: "Resume a paused Grok workflow run",
  },
  {
    name: "workflow stop",
    description: "Stop a Grok workflow run",
    input: { hint: "run name" },
  },
];

export interface GrokWorkflowScriptMeta {
  readonly name: string;
  readonly description: string | undefined;
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
}

/** HOME on Unix; USERPROFILE when HOME is unset (Windows / stripped instance env). */
export function grokWorkflowHomeDirFromEnvironment(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  return trimmed(environment.HOME) ?? trimmed(environment.USERPROFILE);
}

function quotedField(source: string, field: string): string | undefined {
  const match = source.match(new RegExp(`\\b${field}\\s*:\\s*"([^"]+)"`));
  return trimmed(match?.[1]);
}

export function parseGrokWorkflowScriptMeta(
  source: string,
  fallbackName?: string,
): GrokWorkflowScriptMeta | undefined {
  const block = source.match(/let\s+meta\s*=\s*#\{([\s\S]*?)\};/);
  const scope = block?.[1] ?? source;
  const name = quotedField(scope, "name") ?? trimmed(fallbackName);
  if (name === undefined || name.includes("/") || name.includes("\\")) {
    return undefined;
  }
  return {
    name,
    description: quotedField(scope, "description"),
  };
}

export function grokWorkflowSlashCommandFromMeta(
  meta: GrokWorkflowScriptMeta,
): ServerProviderSlashCommand {
  return {
    name: `workflow ${meta.name}`,
    ...(meta.description
      ? { description: meta.description }
      : { description: `Launch ${meta.name}` }),
  };
}

const readWorkflowDir = Effect.fn("grok.readWorkflowDir")(function* (
  dir: string,
  byName: Map<string, ServerProviderSlashCommand>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem
    .readDirectory(dir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  for (const entry of entries) {
    if (!entry.endsWith(".rhai")) {
      continue;
    }
    const filePath = path.join(dir, entry);
    const info = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => undefined));
    if (!info || info.type !== "File" || info.size <= 0n) {
      continue;
    }
    const length = info.size > BigInt(SCRIPT_BYTE_CAP) ? SCRIPT_BYTE_CAP : Number(info.size);
    const bytes = yield* Effect.scoped(
      fileSystem
        .open(filePath, { flag: "r" })
        .pipe(Effect.flatMap((file) => file.readAlloc(length))),
    ).pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(bytes)) {
      continue;
    }
    const source = new TextDecoder().decode(bytes.value);
    const fallbackName = entry.endsWith(".rhai") ? entry.slice(0, -".rhai".length) : entry;
    const meta = parseGrokWorkflowScriptMeta(source, fallbackName);
    if (!meta) {
      continue;
    }
    const command = grokWorkflowSlashCommandFromMeta(meta);
    byName.set(command.name, command);
  }
});

/**
 * Built-in `/workflow pause|resume|stop` plus `~/.grok/workflows` and
 * `<project>/.grok/workflows` scripts. Project scripts override user scripts
 * of the same command name. T3 sends the slash text as a prompt — it does not
 * host Rhai.
 */
export const readGrokWorkflowSlashCommands = Effect.fn("grok.readWorkflowSlashCommands")(
  function* (input: {
    readonly projectRoot?: string | undefined;
    readonly homeDir?: string | undefined;
  }) {
    const path = yield* Path.Path;
    const byName = new Map<string, ServerProviderSlashCommand>();
    for (const command of GROK_WORKFLOW_CONTROL_COMMANDS) {
      byName.set(command.name, command);
    }
    const homeDir = trimmed(input.homeDir) ?? grokWorkflowHomeDirFromEnvironment(process.env);
    if (homeDir) {
      yield* readWorkflowDir(path.join(homeDir, ".grok", "workflows"), byName);
    }
    const projectRoot = trimmed(input.projectRoot);
    if (projectRoot && path.isAbsolute(projectRoot)) {
      yield* readWorkflowDir(path.join(projectRoot, ".grok", "workflows"), byName);
    }
    return [...byName.values()];
  },
);
