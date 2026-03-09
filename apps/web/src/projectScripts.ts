import {
  MAX_SCRIPT_ID_LENGTH,
  SCRIPT_RUN_COMMAND_PATTERN,
  type KeybindingCommand,
  type ProjectScript,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { Schema } from "effect";

function normalizeScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    return "script";
  }
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) {
    return cleaned;
  }
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

export const commandForProjectScript = (scriptId: string): KeybindingCommand =>
  SCRIPT_RUN_COMMAND_PATTERN.makeUnsafe(`script.${scriptId}.run`);

export function projectScriptIdFromCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!Schema.is(SCRIPT_RUN_COMMAND_PATTERN)(trimmed)) {
    return null;
  }
  const [prefix, , suffix] = SCRIPT_RUN_COMMAND_PATTERN.parts;
  return trimmed.slice(prefix.literal.length, -suffix.literal.length);
}

export function nextProjectScriptId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(Array.from(existingIds));
  const baseId = normalizeScriptId(name);
  if (!taken.has(baseId)) return baseId;

  let suffix = 2;
  while (suffix < 10_000) {
    const candidate = `${baseId}-${suffix}`;
    const safeCandidate =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safeCandidate)) {
      return safeCandidate;
    }
    suffix += 1;
  }

  // This last-resort fallback only triggers after exhausting thousands of suffixes.
  return `${baseId}-${Date.now()}`.slice(0, MAX_SCRIPT_ID_LENGTH);
}

function isLifecycleProjectScript(script: ProjectScript): boolean {
  return script.runOnWorktreeCreate || script.runOnWorktreeDelete;
}

export { projectScriptRuntimeEnv };

export function primaryProjectScript(scripts: ProjectScript[]): ProjectScript | null {
  const regular = scripts.find((script) => !isLifecycleProjectScript(script));
  return regular ?? scripts[0] ?? null;
}

export function setupProjectScript(scripts: ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}

export function cleanupProjectScript(scripts: ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeDelete) ?? null;
}

export function projectScriptLifecycleLabel(script: ProjectScript): string | null {
  if (script.runOnWorktreeCreate && script.runOnWorktreeDelete) {
    return "setup, cleanup";
  }
  if (script.runOnWorktreeCreate) {
    return "setup";
  }
  if (script.runOnWorktreeDelete) {
    return "cleanup";
  }
  return null;
}

export function upsertProjectScript(
  scripts: ProjectScript[],
  nextScript: ProjectScript,
): ProjectScript[] {
  const nextScripts: ProjectScript[] = [];
  let replacedExisting = false;

  for (const script of scripts) {
    if (script.id === nextScript.id) {
      nextScripts.push(nextScript);
      replacedExisting = true;
      continue;
    }

    let normalizedScript = script;
    if (nextScript.runOnWorktreeCreate && normalizedScript.runOnWorktreeCreate) {
      normalizedScript = { ...normalizedScript, runOnWorktreeCreate: false };
    }
    if (nextScript.runOnWorktreeDelete && normalizedScript.runOnWorktreeDelete) {
      normalizedScript = { ...normalizedScript, runOnWorktreeDelete: false };
    }
    nextScripts.push(normalizedScript);
  }

  if (!replacedExisting) {
    nextScripts.push(nextScript);
  }

  return nextScripts;
}
