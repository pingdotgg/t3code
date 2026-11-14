import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { IssuesPage, type IssuesSearch } from "../components/issue/IssuesPage";

// The router reads a bare `key=42` as a number.
const bounded = (value: unknown): string | undefined => {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && text.trim() ? text.trim().slice(0, 200) : undefined;
};
/** A search key that is either present as a string or absent, never present as undefined. */
function present<K extends string, V extends string>(
  key: K,
  value: string | undefined,
): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]: V });
}

export const Route = createFileRoute("/_chat/issues")({
  validateSearch: (raw: Record<string, unknown>): IssuesSearch => ({
    who:
      raw.who === "assigned" || raw.who === "authored" || raw.who === "mentioned" ? raw.who : "all",
    status: raw.status === "closed" || raw.status === "all" ? raw.status : "open",
    ...present("host", bounded(raw.host)),
    // Always an own key: the router lays this over the parent route's unvalidated search.
    q: bounded(raw.q),
    ...present<"selectedEnvironmentId", EnvironmentId>(
      "selectedEnvironmentId",
      bounded(raw.selectedEnvironmentId),
    ),
    ...present<"selectedProjectId", ProjectId>("selectedProjectId", bounded(raw.selectedProjectId)),
    ...present("selectedHost", bounded(raw.selectedHost)),
    ...present("tracker", bounded(raw.tracker)),
    ...present("scope", bounded(raw.scope)),
    ...present("key", bounded(raw.key)),
  }),
  component: IssuesPage,
});
