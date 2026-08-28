import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  addWorkItem,
  isWorkItemSelected,
  type SelectedWorkItem,
  useWorkItemSelection,
} from "./workItemSelection";

const issue: SelectedWorkItem = {
  kind: "issue",
  provider: "linear",
  environmentId: "env-1" as SelectedWorkItem["environmentId"],
  projectId: "project-1" as SelectedWorkItem["projectId"],
  repository: "acme/app",
  number: 12,
  title: "Fix login",
  url: "https://linear.app/acme/issue/APP-12",
};

afterEach(() => useWorkItemSelection.getState().clear());

describe("addWorkItem", () => {
  it("mixes issues and pull requests from one project", () => {
    const pullRequest = {
      ...issue,
      kind: "pull-request" as const,
      provider: "github",
      number: 34,
    };

    expect(addWorkItem([issue], pullRequest)).toEqual({
      items: [issue, pullRequest],
      error: null,
    });
  });

  it("keeps equal issue references from two providers", () => {
    const github = { ...issue, provider: "github" };

    expect(isWorkItemSelected([issue], github)).toBe(false);
  });

  it("rejects work from another project", () => {
    const other = {
      ...issue,
      projectId: "project-2" as SelectedWorkItem["projectId"],
      number: 99,
    };

    expect(addWorkItem([issue], other)).toEqual({ items: [issue], error: "project" });
  });

  it("caps a task at twenty sources", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({ ...issue, number: index + 1 }));

    expect(addWorkItem(items, { ...issue, number: 21 })).toEqual({ items, error: "limit" });
  });

  it("starts selection when the first item is toggled", () => {
    useWorkItemSelection.getState().toggle(issue);
    expect(useWorkItemSelection.getState()).toMatchObject({ selecting: true, items: [issue] });
  });

  it("ends selection when the last item is toggled off", () => {
    useWorkItemSelection.setState({ selecting: true, items: [issue] });
    useWorkItemSelection.getState().toggle(issue);
    expect(useWorkItemSelection.getState()).toMatchObject({ selecting: false, items: [] });
  });
});
