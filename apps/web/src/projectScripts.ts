import type { ProjectScript } from "@t3tools/contracts";

import { isWindowsPlatform } from "./lib/utils";

const SCRIPT_RUN_COMMAND_PATTERN = /^script\.([a-z0-9][a-z0-9-]*)\.run$/;
const MAX_SCRIPT_ID_LENGTH = 64;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

export function commandForProjectScript(scriptId: string): string {
  return `script.${scriptId}.run`;
}

export function projectScriptIdFromCommand(command: string): string | null {
  const match = SCRIPT_RUN_COMMAND_PATTERN.exec(command.trim());
  return match?.[1] ?? null;
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

  return `${baseId}-${Date.now()}`.slice(0, MAX_SCRIPT_ID_LENGTH);
}

function shellEscapePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellEscapeWindowsSetValue(value: string): string {
  return value.replace(/"/g, '""');
}

export function injectEnvIntoShellCommand(
  command: string,
  env: Record<string, string>,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): string {
  const entries = Object.entries(env).filter(
    ([key, value]) => ENV_KEY_PATTERN.test(key) && value.length > 0,
  );
  if (entries.length === 0) {
    return command;
  }

  if (isWindowsPlatform(platform)) {
    const prefixes = entries.map(
      ([key, value]) => `set "${key}=${shellEscapeWindowsSetValue(value)}"`,
    );
    return `${prefixes.join(" && ")} && ${command}`;
  }

  const assignments = entries.map(([key, value]) => `${key}=${shellEscapePosix(value)}`).join(" ");
  return `env ${assignments} ${command}`;
}

export function primaryProjectScript(scripts: ProjectScript[]): ProjectScript | null {
  const regular = scripts.find((script) => !script.runOnWorktreeCreate);
  return regular ?? scripts[0] ?? null;
}

export function setupProjectScript(scripts: ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}
