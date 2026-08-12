import "../../index.css";

import { ProjectId, type PullRequestListEntry } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { PullRequestRow } from "./PullRequestRow";

const entry: PullRequestListEntry = {
  provider: "github",
  host: "github.com",
  projectId: ProjectId.make("project-1"),
  projectTitle: "T3 Code",
  repository: "t3tools/t3code",
  number: 42,
  title: "Improve pull request navigation",
  url: "https://github.com/t3tools/t3code/pull/42",
  author: { login: "octocat", name: "The Octocat", avatarUrl: null },
  headBranch: "feature/pull-requests",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 12,
  deletions: 3,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
  viewerReviewRequested: false,
  labels: [],
};

describe("PullRequestRow", () => {
  it("shows pull request metadata and selects the row", async () => {
    const onSelect = vi.fn();
    await render(<PullRequestRow entry={entry} selected onSelect={onSelect} />);

    const row = page.getByRole("button", { name: /improve pull request navigation/i });
    await expect.element(row).toHaveAttribute("aria-current", "true");
    await expect.element(page.getByText("#42")).toBeVisible();
    await expect.element(page.getByText("+12")).toBeVisible();
    await expect.element(page.getByText("-3")).toBeVisible();

    await row.click();
    expect(onSelect).toHaveBeenCalledWith(entry);
  });
});
