// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ServerProviderSlashCommand } from "@t3tools/contracts";

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

function readWorkflowDir(dir: string, byName: Map<string, ServerProviderSlashCommand>): void {
  let entries: NodeFS.Dirent[];
  try {
    entries = NodeFS.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".rhai")) {
      continue;
    }
    const filePath = NodePath.join(dir, entry.name);
    let source: string;
    try {
      const stat = NodeFS.statSync(filePath);
      if (!stat.isFile() || stat.size <= 0) {
        continue;
      }
      const bytes = NodeFS.readFileSync(filePath, {
        encoding: "utf8",
        flag: "r",
      });
      source = bytes.length > SCRIPT_BYTE_CAP ? bytes.slice(0, SCRIPT_BYTE_CAP) : bytes;
    } catch {
      continue;
    }
    const fallbackName = NodePath.basename(entry.name, ".rhai");
    const meta = parseGrokWorkflowScriptMeta(source, fallbackName);
    if (!meta) {
      continue;
    }
    const command = grokWorkflowSlashCommandFromMeta(meta);
    byName.set(command.name, command);
  }
}

/**
 * Built-in `/workflow pause|resume|stop` plus `~/.grok/workflows` and
 * `<project>/.grok/workflows` scripts. Project scripts override user scripts
 * of the same command name. T3 sends the slash text as a prompt — it does not
 * host Rhai.
 */
export function readGrokWorkflowSlashCommands(input: {
  readonly projectRoot?: string;
  readonly homeDir?: string;
}): ReadonlyArray<ServerProviderSlashCommand> {
  const byName = new Map<string, ServerProviderSlashCommand>();
  for (const command of GROK_WORKFLOW_CONTROL_COMMANDS) {
    byName.set(command.name, command);
  }
  const homeDir = trimmed(input.homeDir) ?? NodeOS.homedir();
  readWorkflowDir(NodePath.join(homeDir, ".grok", "workflows"), byName);
  const projectRoot = trimmed(input.projectRoot);
  if (projectRoot && NodePath.isAbsolute(projectRoot)) {
    readWorkflowDir(NodePath.join(projectRoot, ".grok", "workflows"), byName);
  }
  return [...byName.values()];
}
