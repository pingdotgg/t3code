import {
  formatIssuePropertyScalar,
  isEmptyIssuePropertyValue,
  isIssuePropertyObject,
  issuePropertyObjectLabel,
} from "@t3tools/client-runtime/issue-properties";
import type { IssueProperty } from "@t3tools/contracts";
import { T, useGT } from "gt-react";

import { Badge } from "../ui/badge";

export function IssuePropertyValue({ value }: { value: IssueProperty["value"] }) {
  const gt = useGT();
  if (value === null || isEmptyIssuePropertyValue(value)) {
    return (
      <span className="text-muted-foreground">
        <T context="an issue field with no value">None</T>
      </span>
    );
  }
  if (typeof value === "boolean") {
    return <span>{value ? gt("Yes") : gt("No")}</span>;
  }
  if (typeof value === "string" || typeof value === "number") {
    return (
      <span className="whitespace-pre-wrap wrap-anywhere">{formatIssuePropertyScalar(value)}</span>
    );
  }
  if (!isIssuePropertyObject(value)) {
    const names = value.map((entry) =>
      typeof entry === "string" || typeof entry === "number"
        ? String(entry)
        : isIssuePropertyObject(entry)
          ? issuePropertyObjectLabel(entry)
          : null,
    );
    // Labels, components, people: a list of names reads as a row of tags.
    if (names.every((name) => name !== null)) {
      return (
        <span className="flex min-w-0 flex-wrap gap-1">
          {names.map((name, index) => (
            // Trackers allow repeated names, and position keeps the keys unique.
            // oxlint-disable-next-line react/no-array-index-key
            <Badge key={`${index}:${name}`} variant="secondary" className="max-w-full">
              <span className="truncate">{name}</span>
            </Badge>
          ))}
        </span>
      );
    }
    return (
      <ul className="space-y-1">
        {value.map((entry, index) => (
          // Values have no ids; with the content in the key, an open disclosure is not handed
          // to the entry that takes its place.
          // oxlint-disable-next-line react/no-array-index-key
          <li key={`${index}:${JSON.stringify(entry)}`}>
            <IssuePropertyValue value={entry} />
          </li>
        ))}
      </ul>
    );
  }
  const name = issuePropertyObjectLabel(value);
  if (name !== null) return <span className="wrap-anywhere">{name}</span>;
  // Only an object without a name of its own opens to show its parts.
  return (
    <details>
      <summary className="cursor-pointer">
        <T>View value</T>
      </summary>
      <dl className="mt-2 space-y-1 border-l border-border pl-3">
        {Object.entries(value).map(([key, entry]) => (
          <div key={key} className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">{key}</dt>
            <dd className="min-w-0">
              <IssuePropertyValue value={entry} />
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
