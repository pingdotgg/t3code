import {
  CUSTOM_EDITOR_ID_PREFIX,
  type CustomEditor,
  type CustomEditorId,
  type InstalledApplication,
} from "@t3tools/contracts";

/** Longest label the `CustomEditor` schema accepts. */
const MAX_LABEL_LENGTH = 64;

/** Filters the "Open with" list by name, case- and position-insensitively. */
export function filterApplications(
  applications: ReadonlyArray<InstalledApplication>,
  query: string,
): ReadonlyArray<InstalledApplication> {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return applications;
  return applications.filter((application) => application.name.toLowerCase().includes(trimmed));
}

/**
 * Id for a chosen application. Derived from the discovered application's own
 * id so picking the same program twice reuses its entry instead of stacking
 * up near-duplicates.
 */
export function customEditorIdFor(application: InstalledApplication): CustomEditorId {
  return `${CUSTOM_EDITOR_ID_PREFIX}${application.id}` as CustomEditorId;
}

/**
 * Remembers a picked application in the Open menu. Re-picking an application
 * already in the list refreshes its command and arguments in place, so an
 * entry whose program was reinstalled elsewhere repairs itself.
 */
export function rememberApplication(
  existing: ReadonlyArray<CustomEditor>,
  application: InstalledApplication,
): ReadonlyArray<CustomEditor> {
  const id = customEditorIdFor(application);
  const entry: CustomEditor = {
    id,
    label: application.name.slice(0, MAX_LABEL_LENGTH),
    command: application.command,
    args: application.args,
  };
  return existing.some((candidate) => candidate.id === id)
    ? existing.map((candidate) => (candidate.id === id ? entry : candidate))
    : [...existing, entry];
}

export function forgetApplication(
  existing: ReadonlyArray<CustomEditor>,
  id: CustomEditorId,
): ReadonlyArray<CustomEditor> {
  return existing.filter((entry) => entry.id !== id);
}
