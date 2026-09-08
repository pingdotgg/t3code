import type { ThreadEnvMode } from "@t3tools/contracts";

export interface ProjectSettingSourceEntry {
  key: string;
  label: string;
  value: string;
  source: string;
  overridden: boolean;
  defaultValue?: string;
}

export function summarizeProjectSettingSources(entries: readonly ProjectSettingSourceEntry[]) {
  const overrideCount = entries.filter((entry) => entry.overridden).length;
  if (entries.length === 1) return entries[0]!.source;
  if (entries.some((entry) => entry.source === "Unavailable")) return "Some sources unavailable";
  if (overrideCount === 0) return "Inherited per checkout";
  if (overrideCount === entries.length) return `Overridden in ${overrideCount} checkouts`;
  return `${overrideCount} overridden · ${entries.length - overrideCount} inherited`;
}

export function resolveProjectBooleanSource(
  override: boolean | undefined,
  environmentDefault: boolean | undefined,
  legacyOverride = false,
) {
  return {
    value: override ?? (legacyOverride ? true : environmentDefault),
    overridden: override !== undefined || legacyOverride,
  };
}

export function resolveProjectWorkspaceSource(input: {
  override: ThreadEnvMode | null;
  environmentDefault: ThreadEnvMode | undefined;
  repositoryDefault: ThreadEnvMode | null;
  repositoryResolved: boolean;
}) {
  if (input.override !== null) {
    return { value: input.override, source: "Project override", overridden: true };
  }
  if (!input.repositoryResolved) {
    return { value: undefined, source: "t3.json or environment default", overridden: false };
  }
  if (input.repositoryDefault !== null) {
    return { value: input.repositoryDefault, source: "t3.json", overridden: false };
  }
  if (input.environmentDefault === undefined) {
    return { value: undefined, source: "Unavailable", overridden: false };
  }
  return { value: input.environmentDefault, source: "Environment default", overridden: false };
}
