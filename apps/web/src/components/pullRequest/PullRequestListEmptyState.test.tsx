/**
 * Which of the four states wins, and which of them offer to ask the hosts again. The component is
 * called as a plain function and its tree read for text: the elements are walked rather than
 * invoked, so the button's own hooks never run outside a render.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { PullRequestListEmptyState } from "./PullRequestListEmptyState";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isValidElement(node)) return "";
  return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
}

const baseProps = {
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
  return textOf(PullRequestListEmptyState({ ...baseProps, ...props }));
}

describe("PullRequestListEmptyState", () => {
  it("asks for a project ahead of anything a search or a filter could say", () => {
    const text = render({ hasProjects: false, searching: true, query: "fix", filtered: true });
    expect(text).toContain("No projects in this workspace");
    expect(text).toContain("Add project");
  });

  it("leaves the retry off the states where asking again could not change the answer", () => {
    expect(render({ hasProjects: false })).not.toContain("Check again");
    expect(render({ searching: true, query: "fix" })).not.toContain("Check again");
  });

  it("offers the retry once the hosts have answered", () => {
    expect(render({})).toContain("Check again");
    expect(render({ filtered: true })).toContain("Check again");
    expect(render({ query: "fix" })).toContain("Check again");
    expect(render({ canLoadMore: true })).toContain("Load more pull requests");
    expect(render({ refreshing: true })).toContain("Checking...");
  });
});
