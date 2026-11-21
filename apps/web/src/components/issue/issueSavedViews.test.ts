import { describe, expect, it } from "vite-plus/test";

import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { issueListPreferences, IssueListPreferencesSchema } from "./issueListPreferences";
import { issueViewMatches } from "./issueSavedViews";

const decodePreferences = Schema.decodeOption(IssueListPreferencesSchema);

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

  it("keeps a selection of every project within what it reads back", () => {
    const many = Array.from(
      { length: 1_001 },
      (_, index) => [EnvironmentId.make("env-1"), ProjectId.make(`project-${index}`)] as const,
    );
    const stored = issueListPreferences({ ...preferences, hideProjects: many });
    const restored = decodePreferences(stored);
    expect(restored._tag === "Some" && restored.value.hideProjects).toEqual(many.slice(0, 1_000));
  });
});
