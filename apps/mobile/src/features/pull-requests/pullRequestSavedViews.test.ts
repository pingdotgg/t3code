import { expect, it } from "vite-plus/test";
import type { PullRequestSavedView } from "../../persistence/mobile-preferences";
import { pullRequestViewMatches } from "./pullRequestSavedViews";

const view = {
  id: "review",
  name: "Review queue",
  environmentId: "remote",
  query: "bug",
  controls: {
    state: "open",
    involvement: "reviewing",
    filters: {
      author: "me",
      draft: "hide",
      labels: [["bug", "fix"], ["urgent"]],
      excludedLabels: ["hold", "later"],
    },
    sort: "created",
    projectId: "project",
    projectEnvironmentId: "remote",
  },
} as const satisfies PullRequestSavedView;

it("recognizes a saved view regardless of filter property or label ordering", () => {
  const controls = {
    ...view.controls,
    filters: {
      excludedLabels: ["later", "hold"],
      labels: [["urgent"], ["fix", "bug"]],
      draft: "hide",
      author: "me",
    },
  } as const;
  expect(pullRequestViewMatches(view, { ...view, query: " bug ", controls })).toBe(true);
  expect(view.controls.filters.labels).toEqual([["bug", "fix"], ["urgent"]]);
});

it("marks the view modified when search, sort, environment, or project environment changes", () => {
  expect(pullRequestViewMatches(view, { ...view, query: "different" })).toBe(false);
  expect(pullRequestViewMatches(view, { ...view, environmentId: null })).toBe(false);
  expect(
    pullRequestViewMatches(view, { ...view, controls: { ...view.controls, sort: "oldest" } }),
  ).toBe(false);
  expect(
    pullRequestViewMatches(view, {
      ...view,
      controls: { ...view.controls, projectEnvironmentId: "other" },
    }),
  ).toBe(false);
});
