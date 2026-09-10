/**
 * Which of the four states wins, and which of them offer to ask the hosts again. The component is
 * called as a plain function and its tree read for text: the elements are walked rather than
 * invoked, so the button's own hooks never run outside a render.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { ListEmptyState } from "./ListEmptyState";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isValidElement(node)) return "";
  return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
}

const baseProps = {
  mark: null,
  loadingLabel: "Loading issues",
  noProjectsDescription: "Add a project, and the issues from its repository appear here.",
  notFoundHint: "The hosts were searched for it.",
  emptyTitle: "No issues",
  emptyDescription: "Issues from every project in this workspace appear here.",
  loadMoreLabel: "Load more issues",
  query: "",
  filtered: false,
  searching: false,
  hasProjects: true,
  canLoadMore: false,
  loadingMore: false,
  refreshing: false,
  onClearQuery: () => {},
  onLoadMore: () => {},
  onRefresh: () => {},
};

function render(props: Partial<typeof baseProps>): string {
  return textOf(ListEmptyState({ ...baseProps, ...props }));
}

describe("ListEmptyState", () => {
  it("asks for a project ahead of anything a search or a filter could say", () => {
    const text = render({ hasProjects: false, searching: true, query: "crash", filtered: true });
    expect(text).toContain("No projects in this workspace");
    expect(text).toContain("Add project");
  });

  it("leaves the retry off the states where asking again could not change the answer", () => {
    expect(render({ hasProjects: false })).not.toContain("Check again");
    expect(render({ searching: true, query: "crash" })).not.toContain("Check again");
  });

  it("offers the retry once the hosts have answered", () => {
    expect(render({})).toContain("Check again");
    expect(render({ filtered: true })).toContain("Check again");
    expect(render({ query: "crash" })).toContain("Check again");
    expect(render({ canLoadMore: true })).toContain("Load more issues");
    expect(render({ refreshing: true })).toContain("Checking...");
  });

  it("says what was searched for, and says a filtered list is filtered", () => {
    expect(render({ query: "crash" })).toContain("Nothing matches");
    expect(render({ filtered: true })).toContain("Nothing under these filters");
    expect(render({})).toContain("No issues");
  });
});
