import { EnvironmentId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { makeThreadFixture } from "../test-fixtures";
import { ThreadPullRequestsMiniList, ThreadRowLeadingStatus } from "./ThreadStatusIndicators";

const environmentId = EnvironmentId.make("environment-test");

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProject: () => null,
  useServerConfigs: (() =>
    new Map([
      [environmentId, { environment: { capabilities: { threadPullRequests: true } } }],
    ])) as never,
}));

it("updates palette PR status from linked snapshots without a legacy link or branch PR", async () => {
  const link: ThreadPullRequestLink = {
    host: "github.com",
    repository: "example/repo",
    number: 7,
    url: "https://github.com/example/repo/pull/7",
    source: "manual",
    linkedAt: "2026-01-01T00:00:00Z",
    stack: null,
    snapshot: {
      state: "merged",
      title: "Linked change",
      headBranch: "deleted-branch",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-01-03T00:00:00Z",
    },
  };
  const row = (pullRequest: ThreadPullRequestLink) => (
    <AppAtomRegistryProvider>
      <ThreadRowLeadingStatus
        thread={makeThreadFixture({
          environmentId,
          linkedPullRequest: null,
          branchPullRequest: null,
          pullRequests: [pullRequest],
        })}
      />
    </AppAtomRegistryProvider>
  );
  await using screen = await render(row(link));
  await expect.element(screen.getByLabelText("PR #7 - Merged: Linked change")).toBeVisible();
  await expect.element(screen.getByLabelText("PR #7, status pending")).not.toBeInTheDocument();

  await screen.rerender(row({ ...link, snapshot: null }));
  await expect.element(screen.getByLabelText("PR #7, status pending")).toBeVisible();
  await expect
    .element(screen.getByLabelText("PR #7 - Merged: Linked change"))
    .not.toBeInTheDocument();

  await screen.rerender(
    row({ ...link, snapshot: { ...link.snapshot!, state: "open", isDraft: true } }),
  );
  await expect.element(screen.getByLabelText("PR #7 - Draft: Linked change")).toBeVisible();
  await expect.element(screen.getByLabelText("PR #7, status pending")).not.toBeInTheDocument();
});

it.each([1, 6, 1125])("caps a %i-link hover preview at five PR rows", async (count) => {
  const links: ThreadPullRequestLink[] = Array.from({ length: count }, (_, index) => ({
    host: "github.com",
    repository: "example/repo",
    number: index + 1,
    url: `https://github.com/example/repo/pull/${index + 1}`,
    source: "manual",
    linkedAt: "2026-01-01T00:00:00Z",
    stack: null,
    snapshot: null,
  }));
  await using screen = await render(<ThreadPullRequestsMiniList pullRequests={links} />);
  expect(screen.getByRole("listitem").all()).toHaveLength(Math.min(count, 5) + (count > 5 ? 1 : 0));
  await expect.element(screen.getByText("#1", { exact: true })).toBeVisible();
  if (count > 5) {
    await expect.element(screen.getByText(`${count - 5} more`, { exact: true })).toBeVisible();
    await expect.element(screen.getByText("#6", { exact: true })).not.toBeInTheDocument();
  }
});
