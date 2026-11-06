import type { IssueProperty } from "@t3tools/contracts";

type IssuePropertyValue = IssueProperty["value"];

export type IssuePropertyObject = Exclude<
  Extract<IssuePropertyValue, object>,
  ReadonlyArray<unknown>
>;

/** `Array.isArray` does not narrow readonly arrays, so object values get their own guard. */
export function isIssuePropertyObject(value: IssuePropertyValue): value is IssuePropertyObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Unset in the host's sense: nothing a reader would need to see to know about the issue. */
export function isEmptyIssuePropertyValue(value: IssuePropertyValue): boolean {
  if (value === null || value === "") return true;
  if (Array.isArray(value)) return value.every(isEmptyIssuePropertyValue);
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Hosts send timestamps as ISO strings; everything else is shown as the host wrote it. */
export function formatIssuePropertyScalar(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" && TIMESTAMP.test(value)) {
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return new Date(time).toLocaleString();
  }
  return String(value);
}

/** The name a host gives an object value — a user, a status, an option — when it has one. */
export function issuePropertyObjectLabel(value: {
  readonly [key: string]: unknown;
}): string | null {
  for (const key of ["displayName", "name", "value", "title", "login", "key"]) {
    const candidate = value[key];
    if (typeof candidate === "string" || typeof candidate === "number") return String(candidate);
  }
  return null;
}

/** Fields a reader looks for first on any Jira issue, in the order Jira's own sidebar shows them. */
const JIRA_LEADING_FIELDS = [
  "status",
  "assignee",
  "reporter",
  "priority",
  "issuetype",
  "labels",
  "components",
  "fixVersions",
  "parent",
  "duedate",
  "created",
  "updated",
  "resolution",
  "resolutiondate",
];

/**
 * Jira hands fields back in no useful order and with hundreds of custom fields, so the familiar
 * ones lead and the rest sort by name. Forge hosts arrive already curated and keep their order.
 */
export function orderIssueProperties<T extends { readonly id: string; readonly label: string }>(
  provider: string,
  properties: ReadonlyArray<T>,
): ReadonlyArray<T> {
  if (provider !== "jira") return properties;
  const rank = (id: string) => {
    const index = JIRA_LEADING_FIELDS.indexOf(id);
    return index === -1 ? JIRA_LEADING_FIELDS.length : index;
  };
  return properties.toSorted(
    (left, right) =>
      rank(left.id) - rank(right.id) ||
      left.label.localeCompare(right.label, undefined, { sensitivity: "base" }),
  );
}
