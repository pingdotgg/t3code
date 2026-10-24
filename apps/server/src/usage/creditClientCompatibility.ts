import type { ServerSettings, UsageLimitSourceSnapshot } from "@t3tools/contracts";

/** Shipped clients only recognize CLI proxy settings and source snapshots. */
export function legacyCreditSettings(settings: ServerSettings): ServerSettings {
  return {
    ...settings,
    usageLimitSources: Object.fromEntries(
      Object.entries(settings.usageLimitSources).filter(([, source]) => source.kind !== "credits"),
    ),
  };
}
export function legacyCreditSources(
  sources: readonly UsageLimitSourceSnapshot[],
): UsageLimitSourceSnapshot[] {
  return sources.filter((source) => source.kind !== "credits");
}
