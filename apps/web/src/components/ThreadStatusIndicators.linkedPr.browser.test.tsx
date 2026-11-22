import { EnvironmentId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { resolveThreadPullRequestBadge } from "@t3tools/client-runtime/thread-pull-requests";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { makeThreadFixture } from "../test-fixtures";
import {
  ThreadPullRequestBadgeControl,
  ThreadPullRequestsMiniList,
  ThreadRowLeadingStatus,
} from "./ThreadStatusIndicators";
import { InlineButton } from "./ui/button";

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

it("previews eight ordered stack layers and opens the full list from the badge", async () => {
  const pullRequests: ReadonlyArray<ThreadPullRequestLink> = Array.from(
    { length: 10 },
    (_, index) => {
      const number = 10 - index;
      return {
        host: "github.com",
        repository: "example/repo",
        number,
        url: `https://github.com/example/repo/pull/${number}`,
        source: "manual",
        linkedAt: "2026-01-01T00:00:00Z",
        stack: null,
        snapshot: {
          state: "open",
          title: `Layer ${number}`,
          headBranch: `layer-${number}`,
          baseBranch: number === 1 ? "main" : `layer-${number - 1}`,
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-01-03T00:00:00Z",
        },
      };
    },
  );
  const onOpenList = vi.fn();
  await using screen = await render(
    <ThreadPullRequestsMiniList pullRequests={pullRequests} maxItems={8} />,
  );
  const items = screen.getByRole("listitem").elements();
  expect(items).toHaveLength(9);
  expect(items.slice(0, 8).map((item) => item.querySelector(".font-mono")?.textContent)).toEqual([
    "#1",
    "#2",
    "#3",
    "#4",
    "#5",
    "#6",
    "#7",
    "#8",
  ]);
  expect(items[0]?.textContent).toContain("chain · 10");
  expect(items[1]?.getAttribute("style")).toContain("padding-left: 0.75rem");
  expect(items[8]).toHaveTextContent("+2 more");
  expect(screen.getByRole("button", { name: "+2 more" }).query()).toBeNull();

  await screen.rerender(
    <ThreadPullRequestBadgeControl
      render={<InlineButton />}
      badge={resolveThreadPullRequestBadge(pullRequests)}
      pullRequests={pullRequests}
      status={null}
      onOpenList={onOpenList}
      onOpenPullRequest={vi.fn()}
    />,
  );
  await userEvent.keyboard("{Tab}");
  const more = page.getByRole("button", { name: "+2 more" });
  await expect.element(more).toBeVisible();
  expect(page.getByRole("link").elements()).toHaveLength(8);
  await userEvent.click(more);
  expect(onOpenList).toHaveBeenCalledOnce();
});
