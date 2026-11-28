import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { savedViewNameError } from "@t3tools/client-runtime/saved-views";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestListPreferences,
  type PullRequestListPreferences,
} from "./pullRequestListPreferences";
import { pullRequestSavedViewPatch, pullRequestViewMatches } from "./pullRequestSavedViews";

const preferences = {
  involvement: "reviewing",
  state: "open",
  environmentId: EnvironmentId.make("remote"),
  projectId: ProjectId.make("project"),
  host: "github.example.com",
  q: "label:bug authentication",
  draft: "hide",
  review: "review-required",
  checks: "passing",
  author: "me",
  labels: ["bug", "priority"],
  sort: "updated",
} as const satisfies PullRequestListPreferences;
const view = { id: "review", name: "PRs Requesting My Review", preferences };

describe("saved PR views", () => {
  it("replaces all filters while preserving the selected PR", () => {
    const current = {
      ...preferences,
      repository: "org/repo",
      number: 42,
      selectedHost: "github.com",
      selectedEnvironmentId: EnvironmentId.make("other"),
      selectedProjectId: ProjectId.make("other"),
    };
    const restored = {
      ...current,
      ...pullRequestSavedViewPatch({ involvement: "all", state: "merged" }),
    };
    expect(pullRequestListPreferences(restored)).toEqual({ involvement: "all", state: "merged" });
    expect(restored).toMatchObject({
      repository: "org/repo",
      number: 42,
      selectedHost: "github.com",
      selectedEnvironmentId: "other",
      selectedProjectId: "other",
    });
  });

  it("restores scoped filters without conflating a project on two environments", () => {
    const previous = { involvement: "all", state: "closed" } as const;
    expect(
      pullRequestListPreferences({
        ...previous,
        ...pullRequestSavedViewPatch(preferences),
      }),
    ).toEqual(preferences);
    expect(
      pullRequestViewMatches(view, {
        ...preferences,
        environmentId: EnvironmentId.make("another"),
      }),
    ).toBe(false);
  });

  it("matches default sorting and label sets regardless of selection or label order", () => {
    const defaultView = { ...view, preferences: { ...preferences, sort: undefined } };
    expect(
      pullRequestViewMatches(defaultView, {
        ...preferences,
        labels: ["priority", "bug"],
        sort: "ready",
      }),
    ).toBe(true);
    expect(pullRequestViewMatches(view, { ...preferences, q: "different" })).toBe(false);
    expect(pullRequestViewMatches(view, { ...preferences, labels: ["bug"] })).toBe(false);
  });

  it("rejects blank and duplicate names while allowing a view to keep its own name", () => {
    expect(savedViewNameError("   ", [view])).toBeTruthy();
    expect(savedViewNameError("x".repeat(81), [view])).toBeTruthy();
    expect(savedViewNameError("  PRS REQUESTING MY REVIEW  ", [view])).toBeTruthy();
    expect(savedViewNameError(view.name, [view], view.id)).toBeNull();
    expect(savedViewNameError("  My PRs  ", [view])).toBeNull();
  });
});
