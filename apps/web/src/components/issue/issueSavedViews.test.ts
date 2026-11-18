import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { issueViewMatches } from "./issueSavedViews";

const preferences = {
  who: "assigned",
  status: "open",
  hideProjects: [
    [EnvironmentId.make("env-1"), ProjectId.make("project-1")],
    [EnvironmentId.make("env-1"), ProjectId.make("project-2")],
  ],
  host: "github.com",
  q: "crash",
  label: ["bug", "priority"],
  assignee: "octocat",
  order: "created",
} as const;
const view = { id: "mine", name: "Issues Assigned to Me", preferences };

describe("saved issue views", () => {
  it("matches regardless of label order", () => {
    expect(issueViewMatches(view, { ...preferences, label: ["priority", "bug"], q: "crash" })).toBe(
      true,
    );
    expect(issueViewMatches(view, { ...preferences, assignee: undefined })).toBe(false);
    expect(issueViewMatches(view, { ...preferences, label: ["bug"] })).toBe(false);
    expect(
      issueViewMatches(view, {
        ...preferences,
        hideProjects: preferences.hideProjects.toReversed(),
      }),
    ).toBe(true);
    expect(issueViewMatches(view, { ...preferences, hideProjects: undefined })).toBe(false);
  });
});
