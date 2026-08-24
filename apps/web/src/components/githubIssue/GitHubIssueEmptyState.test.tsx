import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { EmptyContent } from "../ui/empty";
import { GitHubIssueEmptyState } from "./GitHubIssueDetailPanel";

function elementsOf(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elementsOf);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...elementsOf(element.props.children)];
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isValidElement(node)) return "";
  return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
}

describe("GitHubIssueEmptyState", () => {
  it("says what happened without offering a futile retry", () => {
    const state = GitHubIssueEmptyState({
      title: "GitHub issues unavailable",
      description: "Update this environment's T3 Code server to browse GitHub issues.",
    });

    expect(textOf(state)).toContain("GitHub issues unavailable");
    expect(textOf(state)).toContain("Update this environment's T3 Code server");
    expect(elementsOf(state).some((element) => element.type === EmptyContent)).toBe(false);
  });

  // Empty owns the spacing between its slots, so an action carried on a call-site margin would
  // override that layout and drift from every other empty state in the app.
  it("hands a retry to the slot Empty lays out actions in", () => {
    const state = GitHubIssueEmptyState({
      title: "Could not load issues",
      description: "GitHub did not answer.",
      action: <button type="button">Try again</button>,
    });

    expect(elementsOf(state).some((element) => element.type === EmptyContent)).toBe(true);
    expect(textOf(state)).toContain("Try again");
  });
});
