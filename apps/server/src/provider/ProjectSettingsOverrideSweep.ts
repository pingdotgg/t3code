import { type ProjectId, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Settings from "../serverSettings.ts";

export const findOrphanedProjectIds = (
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  liveProjectIds: ReadonlySet<ProjectId>,
): ReadonlyArray<ProjectId> =>
  Object.keys(settings.projectSettingsOverrides)
    .map((projectId) => projectId as ProjectId)
    .filter((projectId) => !liveProjectIds.has(projectId));

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
