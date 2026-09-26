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

/** Makes exactly `projectKeys` use the look; projects dropped from it return to Default. */
export function setLookProjects(
  settings: ClientSettings,
  lookId: string,
  projectKeys: readonly string[],
) {
  const dropped = Object.entries(settings.projectLookAssignments)
    .filter(([key, value]) => value === lookId && !projectKeys.includes(key))
    .map(([key]) => key);
  return assignLook(assignLook(settings, dropped, null), projectKeys, lookId);
}

export function lookProjectKeys(settings: ClientSettings, lookId: string) {
  return Object.entries(settings.projectLookAssignments)
    .filter(([, value]) => value === lookId)
    .map(([key]) => key);
}

/** Puts a deleted look back where it was, with the projects it had. */
export function restoreLook(
  settings: ClientSettings,
  look: SavedLook,
  index: number,
  projectKeys: readonly string[],
) {
  if (settings.savedLooks.some((entry) => entry.id === look.id)) return settings;
  const savedLooks = [...settings.savedLooks];
  savedLooks.splice(Math.min(index, savedLooks.length), 0, look);
  const projectLookAssignments = { ...settings.projectLookAssignments };
  for (const key of projectKeys) projectLookAssignments[key] ??= look.id;
  return { ...settings, savedLooks, projectLookAssignments };
}

/** "Look 2", "Look 3"… skipping names already taken. */
export function nextLookName(looks: readonly SavedLook[], base = "Look") {
  const names = new Set(looks.map((look) => look.name));
  for (let index = looks.length + 1; ; index += 1) {
    const name = `${base} ${index}`;
    if (!names.has(name)) return name;
  }
}
