import * as Schema from "effect/Schema";

export const ShellEnvironmentModeSchema = Schema.Literals(["allowlist", "all"]);
export type ShellEnvironmentMode = typeof ShellEnvironmentModeSchema.Type;

export interface ShellEnvironmentHarvest {
  readonly mode: ShellEnvironmentMode;
  readonly names: ReadonlyArray<string>;
}

export const DEFAULT_SHELL_ENVIRONMENT_HARVEST: ShellEnvironmentHarvest = {
  mode: "allowlist",
  names: [],
};

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const RESERVED_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  "HOME",
  "OLDPWD",
  "PWD",
  "SHLVL",
  "_",
]);

export function isImportableEnvironmentName(name: string): boolean {
  return ENVIRONMENT_NAME_PATTERN.test(name) && !RESERVED_ENVIRONMENT_NAMES.has(name);
}

export function normalizeShellEnvironmentMode(value: unknown): ShellEnvironmentMode {
  return value === "all" ? "all" : "allowlist";
}

export function normalizeShellEnvironmentNames(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];

  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (!isImportableEnvironmentName(name) || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }

  return names;
}
