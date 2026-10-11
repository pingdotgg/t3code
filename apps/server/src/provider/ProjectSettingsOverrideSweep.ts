/**
 * Removes `projectSettingsOverrides` entries
 * whose project no longer exists.
 *
 * `ProjectService.delete` clears a project's entry as part of deleting the
 * project, but that only covers deletions a server new enough to run that
 * code actually processes. A project deleted by an older server, or one
 * whose cleanup write failed, leaves its override behind:
 * `ProviderInstanceRegistryHydration` folds every project's override in
 * unconditionally, so a machine-disabled provider instance the override once
 * turned on stays probed and alive forever, with no UI left to turn it off.
 *
 * This sweep runs once at boot and removes overrides left over from projects
 * that no longer exist. The settings watcher's normal reconcile picks up
 * whatever it clears, so the registry does not need its own live-project
 * check on every settings change.
 *
 * @module provider/ProjectSettingsOverrideSweep
 */
import { type ProjectId, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Settings from "../serverSettings.ts";

/** Pure so the orphan rule can be tested without layers. */
export const findOrphanedProjectIds = (
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  liveProjectIds: ReadonlySet<ProjectId>,
): ReadonlyArray<ProjectId> =>
  Object.keys(settings.projectSettingsOverrides)
    .map((projectId) => projectId as ProjectId)
    .filter((projectId) => !liveProjectIds.has(projectId));

/**
 * Best-effort: a failed read or write here should not block server startup,
 * and a sweep that does not run to completion is simply retried on the next
 * boot.
 */
export const sweep = Effect.gen(function* () {
  const serverSettings = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;

  const settings = yield* serverSettings.getSettings;
  const liveShells = yield* projectStore.listShells();
  const liveProjectIds = new Set(liveShells.map((shell) => shell.id));

  const orphanedProjectIds = findOrphanedProjectIds(settings, liveProjectIds);
  if (orphanedProjectIds.length === 0) return;

  yield* serverSettings.updateSettings({
    projectSettingsOverrides: Object.fromEntries(
      orphanedProjectIds.map((projectId) => [projectId, null]),
    ),
  });
}).pipe(
  Effect.asVoid,
  Effect.catchCause((cause) =>
    Effect.logWarning("Failed to sweep orphaned project settings overrides.", cause),
  ),
);
