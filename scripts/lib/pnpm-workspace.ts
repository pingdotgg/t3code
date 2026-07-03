import { parse as parseYaml } from "yaml";

export interface PnpmWorkspaceConfig {
  readonly catalog: Record<string, string>;
  readonly overrides: Record<string, string>;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringRecord(
  record: Record<string, unknown>,
  key: string,
  defaultValue: Record<string, string>,
): Record<string, string> {
  const value = record[key];
  if (value === undefined) {
    return defaultValue;
  }
  if (!isObjectRecord(value)) {
    throw new Error(`Expected pnpm-workspace.yaml ${key} to be a string record.`);
  }

  const entries: Array<[string, string]> = [];
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== "string") {
      throw new Error(`Expected pnpm-workspace.yaml ${key}.${entryKey} to be a string.`);
    }
    entries.push([entryKey, entryValue]);
  }
  return Object.fromEntries(entries);
}

export function parsePnpmWorkspaceConfig(source: string): PnpmWorkspaceConfig {
  const parsed: unknown = parseYaml(source);
  if (!isObjectRecord(parsed)) {
    throw new Error("Expected pnpm-workspace.yaml to contain a YAML mapping.");
  }
  return {
    catalog: readStringRecord(parsed, "catalog", {}),
    overrides: readStringRecord(parsed, "overrides", {}),
  };
}
