import type { InstalledApp } from "@t3tools/contracts";

export const COMPOSER_APP_MATCH_LIMIT = 5;

/**
 * Apps offered for an `@` query. Files stay the default: apps only appear
 * once a word of the app name starts with what was typed, so `@src` does not
 * bury paths under application names.
 */
export function matchInstalledApps(
  apps: ReadonlyArray<InstalledApp>,
  query: string,
  limit = COMPOSER_APP_MATCH_LIMIT,
): InstalledApp[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const ranked = apps.flatMap((app) => {
    const name = app.name.toLowerCase();
    if (name.startsWith(needle)) return [{ app, rank: 0 }];
    if (name.split(/[\s-]+/u).some((word) => word.startsWith(needle))) return [{ app, rank: 1 }];
    return [];
  });
  return ranked
    .toSorted(
      (left, right) => left.rank - right.rank || left.app.name.localeCompare(right.app.name),
    )
    .slice(0, limit)
    .map((entry) => entry.app);
}
