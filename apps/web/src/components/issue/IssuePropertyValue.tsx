import { useState } from "react";
import {
  formatIssuePropertyScalar,
  isEmptyIssuePropertyValue,
  isIssuePropertyObject,
  issuePropertyObjectLabel,
  type IssuePropertyObject,
} from "./issueProperties";
import type { IssueProperty } from "@t3tools/contracts";

type PropertyValue = IssueProperty["value"];

export function IssuePropertyValue({ value }: { value: PropertyValue }) {
  if (isEmptyIssuePropertyValue(value)) return <span className="text-muted-foreground">None</span>;
  if (value === null) return null;
  if (Array.isArray(value)) {
    const labels = value.map((entry) =>
      isIssuePropertyObject(entry)
        ? issuePropertyObjectLabel(entry)
        : typeof entry === "string" || typeof entry === "number"
          ? String(entry)
          : null,
    );
    // Labels, components, assignees: a list of names reads as a row of tags.
    if (labels.every((label) => label !== null)) {
      return (
        <span className="flex min-w-0 flex-wrap gap-1">
          {labels.map((label, index) => (
            <span
              // Hosts allow repeated names; position keeps the keys unique.
              // oxlint-disable-next-line react/no-array-index-key
              key={`${index}:${label}`}
              className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-foreground/90"
            >
              {label}
            </span>
          ))}
        </span>
      );
    }
    return (
      <ul className="space-y-1">
        {value.map((entry, index) => (
          // Values have no IDs and these read-only rows contain no component state.
          // oxlint-disable-next-line react/no-array-index-key
          <li key={index}>
            <IssuePropertyValue value={entry} />
          </li>
        ))}
      </ul>
    );
  }
  if (isIssuePropertyObject(value)) return <IssueObjectValue value={value} />;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
    return null;
  return (
    <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
      {formatIssuePropertyScalar(value)}
    </span>
  );
}

function IssueObjectValue({ value }: { value: IssuePropertyObject }) {
  const [expanded, setExpanded] = useState(false);
  const label = issuePropertyObjectLabel(value);
  // A named value — a user, a status, an option — is its name; the rest of the host's object
  // is plumbing. Only a nameless object opens to show its fields.
  if (label !== null)
    return <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{label}</span>;
  const entries = Object.entries(value);
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer [overflow-wrap:anywhere]">
        {`${entries.length} fields`}
      </summary>
      {expanded ? (
        <dl className="mt-2 space-y-1 border-l border-border pl-3">
          {entries.map(([key, entry]) => (
            <div key={key} className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">{key}:</dt>
              <dd className="min-w-0">
                <IssuePropertyValue value={entry} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </details>
  );
}
