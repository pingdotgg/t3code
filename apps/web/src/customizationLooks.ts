import { SharedLook, type ClientSettings, type SavedLook } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";

export function resolveProjectLook(settings: ClientSettings, projectKey: string | null) {
  const id = projectKey === null ? undefined : settings.projectLookAssignments[projectKey];
  return settings.savedLooks.find((look) => look.id === id) ?? null;
}

export function resolveLookSettings(
  settings: ClientSettings,
  projectKey: string | null,
): ClientSettings {
  const look = resolveProjectLook(settings, projectKey);
  return look ? { ...settings, ...look.settings } : settings;
}

/** Whole-map client-local edits preserve every project outside the selection. */
export function assignLook(
  settings: ClientSettings,
  projectKeys: readonly string[],
  lookId: string | null,
) {
  if (lookId !== null && !settings.savedLooks.some((look) => look.id === lookId)) {
    throw new Error("This look no longer exists.");
  }
  const projectLookAssignments = { ...settings.projectLookAssignments };
  for (const key of projectKeys) {
    if (lookId === null) delete projectLookAssignments[key];
    else projectLookAssignments[key] = lookId;
  }
  return { ...settings, projectLookAssignments };
}

export function deleteLook(settings: ClientSettings, id: string) {
  return {
    ...settings,
    savedLooks: settings.savedLooks.filter((look) => look.id !== id),
    projectLookAssignments: Object.fromEntries(
      Object.entries(settings.projectLookAssignments).filter(([, value]) => value !== id),
    ),
  };
}

const decodeSharedLook = Schema.decodeUnknownSync(SharedLook);
const decodeExportedLook = Schema.decodeSync(SharedLook);

export function exportLook(look: SavedLook): string {
  return JSON.stringify(decodeExportedLook({ ...look, version: 1 }), null, 2);
}

export function importLook(json: string, id: string): SavedLook {
  const decoded = decodeSharedLook(JSON.parse(json));
  return { id, name: decoded.name, settings: decoded.settings, theme: decoded.theme };
}
