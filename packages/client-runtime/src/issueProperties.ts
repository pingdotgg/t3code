import type { IssueProperty } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const ISSUE_PROPERTY_PIN_LIMIT = 100;

/** Pinned property ids per issue, keyed by `issuePropertyPinKey`. Kept on the device. */
export const IssuePropertyPins = Schema.Record(
  Schema.String,
  Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
    Schema.isMaxLength(ISSUE_PROPERTY_PIN_LIMIT),
  ),
);
export type IssuePropertyPins = typeof IssuePropertyPins.Type;

export function issuePropertyPinKey(issue: {
  readonly tracker: string;
  readonly host: string;
  readonly scope: string;
  readonly key: string;
}): string {
  // Hosts, repositories and keys are case-insensitive on every tracker.
  return JSON.stringify(
    [issue.tracker, issue.host, issue.scope, issue.key].map((part) => part.toLowerCase()),
  );
}

export function toggleIssuePropertyPin(
  pins: IssuePropertyPins,
  key: string,
  propertyId: string,
): IssuePropertyPins {
  const ids = pins[key] ?? [];
  const next = ids.includes(propertyId)
    ? ids.filter((id) => id !== propertyId)
    : [...ids, propertyId].slice(0, ISSUE_PROPERTY_PIN_LIMIT);
  const rest = Object.fromEntries(Object.entries(pins).filter(([entry]) => entry !== key));
  return next.length === 0 ? rest : { ...rest, [key]: next };
}

/** In the order they were pinned; a pin the tracker no longer reports is skipped, not dropped. */
export function pinnedIssueProperties(
  properties: ReadonlyArray<IssueProperty>,
  ids: ReadonlyArray<string>,
): ReadonlyArray<IssueProperty> {
  const byId = new Map(properties.map((property) => [property.id, property]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

type IssuePropertyValue = IssueProperty["value"];

export type IssuePropertyObject = Exclude<
  Extract<IssuePropertyValue, object>,
  ReadonlyArray<unknown>
>;

/** `Array.isArray` does not narrow readonly arrays, so object values get their own guard. */
export function isIssuePropertyObject(value: IssuePropertyValue): value is IssuePropertyObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Unset as the tracker means it. `false` and `0` are answers, not gaps. */
export function isEmptyIssuePropertyValue(value: IssuePropertyValue): boolean {
  if (value === null || value === "") return true;
  if (Array.isArray(value)) return value.every(isEmptyIssuePropertyValue);
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/**
 * What the properties list shows: a search matches a field's name or id, empty fields included,
 * and without one the empty fields wait behind `showEmpty`.
 */
export function visibleIssueProperties(
  properties: ReadonlyArray<IssueProperty>,
  search: string,
  showEmpty: boolean,
): ReadonlyArray<IssueProperty> {
  const query = search.trim().toLowerCase();
  if (query === "") {
    return showEmpty
      ? properties
      : properties.filter((property) => !isEmptyIssuePropertyValue(property.value));
  }
  return properties.filter((property) =>
    `${property.label}\n${property.id}`.toLowerCase().includes(query),
  );
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Trackers send timestamps as ISO strings; everything else reads as the tracker wrote it. */
export function formatIssuePropertyScalar(value: string | number): string {
  if (typeof value === "string" && TIMESTAMP.test(value)) {
    const time = Date.parse(value);
    if (!Number.isNaN(time)) {
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        time,
      );
    }
  }
  return String(value);
}

/** The name a tracker gives an object value (a person, a status, an option) when it has one. */
export function issuePropertyObjectLabel(value: IssuePropertyObject): string | null {
  for (const key of ["displayName", "name", "value", "title", "login", "key"]) {
    const candidate = value[key];
    if (typeof candidate === "number") return String(candidate);
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return null;
}
