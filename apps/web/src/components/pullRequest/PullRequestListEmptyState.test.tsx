/**
 * Which of the four states wins, and which of them offer to ask the hosts again. The component is
 * statically rendered and its emitted text read, so its hooks (useI18n) run inside a real render.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { i18n } from "@t3tools/shared/i18n";

import { PullRequestListEmptyState } from "./PullRequestListEmptyState";

// The global i18n defaults to zh-CN; assert against the English catalog so the
// copy-based expectations below stay deterministic English strings.
beforeAll(() => i18n.setLocale("en"));
afterAll(() => i18n.setLocale("zh-CN"));

function textOf(markup: string): string {
  // Strip tags and attributes, then collapse whitespace; the assertions below
  // match against that plain text.
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  return textOf(
    renderToStaticMarkup(createElement(PullRequestListEmptyState, { ...baseProps, ...props })),
  );
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
