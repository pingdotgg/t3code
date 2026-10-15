import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { pullRequestViewNameError } from "@t3tools/client-runtime/pull-request-saved-views";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestListPreferences,
  type PullRequestListPreferences,
} from "./pullRequestListPreferences";
import {
  PullRequestSavedViews,
  pullRequestSavedViewPatch,
  pullRequestViewMatches,
} from "./pullRequestSavedViews";

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
const decodeViews = Schema.decodeUnknownSync(PullRequestSavedViews);

describe("saved PR views", () => {
  it("round trips multiple named views with every list setting", () => {
    const views = [
      view,
      { id: "authored", name: "My PRs", preferences: { involvement: "authored", state: "closed" } },
    ];
    expect(decodeViews(JSON.parse(JSON.stringify(views)))).toEqual(views);
  });

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
    expect(pullRequestViewNameError("   ", [view])).toBeTruthy();
    expect(pullRequestViewNameError("x".repeat(81), [view])).toBeTruthy();
    expect(pullRequestViewNameError("  PRS REQUESTING MY REVIEW  ", [view])).toBeTruthy();
    expect(pullRequestViewNameError(view.name, [view], view.id)).toBeNull();
    expect(pullRequestViewNameError("  My PRs  ", [view])).toBeNull();
  });

  it("rejects malformed stored filters", () => {
    expect(() =>
      decodeViews([{ ...view, preferences: { ...preferences, involvement: "unknown" } }]),
    ).toThrow();
  });
});
