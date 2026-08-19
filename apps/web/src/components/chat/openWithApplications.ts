import {
  CUSTOM_EDITOR_ID_PREFIX,
  type CustomEditorId,
  type InstalledApplication,
} from "@t3tools/contracts";

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
 * Id the server assigns to a remembered application, derived from the
 * discovered application's own id. Recomputing it here lets the list mark
 * which applications are already in the Open menu without a second round trip;
 * the server derives the same id when it writes the entry.
 */
export function customEditorIdFor(application: InstalledApplication): CustomEditorId {
  return `${CUSTOM_EDITOR_ID_PREFIX}${application.id}` as CustomEditorId;
}
