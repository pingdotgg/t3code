import type { IssueProperty } from "@t3tools/contracts";

/** The issue a set of pins belongs to: its host's own name for it, on that host. */
export interface IssueIdentity {
  readonly provider: string;
  readonly host: string;
  readonly id: string;
}

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
const STORAGE_PREFIX = "t3:issue-pins:v1:";
const MAX_PINNED_FIELDS = 100;

/** Immutable host IDs keep preferences when a ticket's visible key changes. */
export function issueIdentityKey(identity: IssueIdentity): string {
  return JSON.stringify([
    identity.provider.toLowerCase(),
    identity.host.toLowerCase(),
    identity.id,
  ]);
}

function validFieldIds(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200,
      ),
    ),
  ].slice(0, MAX_PINNED_FIELDS);
}

function resolveStorage(storage?: PreferenceStorage) {
  return storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
}

export function readIssuePins(
  identity: IssueIdentity,
  storage?: PreferenceStorage,
): ReadonlyArray<string> {
  try {
    const raw = resolveStorage(storage)?.getItem(STORAGE_PREFIX + issueIdentityKey(identity));
    return raw ? validFieldIds(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** Only field IDs are saved. Property values and issue bodies stay in the display data. */
export function writeIssuePins(
  identity: IssueIdentity,
  fieldIds: ReadonlyArray<string>,
  storage?: PreferenceStorage,
): void {
  try {
    resolveStorage(storage)?.setItem(
      STORAGE_PREFIX + issueIdentityKey(identity),
      JSON.stringify(validFieldIds(fieldIds)),
    );
  } catch {
    // Pinning remains usable when browser storage is unavailable.
  }
}

export function toggleIssuePin(
  fieldIds: ReadonlyArray<string>,
  fieldId: string,
): ReadonlyArray<string> {
  return fieldIds.includes(fieldId)
    ? fieldIds.filter((id) => id !== fieldId)
    : validFieldIds([...fieldIds, fieldId]);
}

export function pinnedIssueProperties(
  properties: ReadonlyArray<IssueProperty>,
  fieldIds: ReadonlyArray<string>,
): ReadonlyArray<IssueProperty> {
  const byId = new Map(properties.map((property) => [property.id, property]));
  return validFieldIds(fieldIds).flatMap((id) => {
    const property = byId.get(id);
    return property ? [property] : [];
  });
}
