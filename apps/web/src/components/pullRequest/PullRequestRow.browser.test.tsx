import { SourceControlProviderKind } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({})) as never,
}));

import { act, render } from "../../../test/render";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { PullRequestRow } from "./PullRequestRow";

const entry = {
  environmentId: "env-1",
  provider: SourceControlProviderKind.make("github"),
  host: "github.com",
  projectId: "project-1",
  projectTitle: "t3code",
  repository: "pingdotgg/t3code",
  title: "Add the pull requests page",
  url: "https://github.com/pingdotgg/t3code/pull/7",
  author: { login: "octocat", name: null, avatarUrl: null },
  headBranch: "feat/branch-7",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 0,
  deletions: 0,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-02T00:00:00Z",
  viewerReviewRequested: false,
  number: 7,
  labels: [],
} as unknown as EnvironmentPullRequestEntry;

it("keeps a row's intent while either the pointer or focus is still on it", async () => {
  const onIntent = vi.fn();
  await using screen = await render(
    <PullRequestRow
      entry={entry}
      selected={false}
      showProjectTitle
      showProvider={false}
      onSelect={() => undefined}
      onIntent={onIntent}
      hostActions={new Set()}
      onActed={() => undefined}
    />,
  );
  const row = screen.getByRole("button", { name: /Add the pull requests page/ });

  await act(() => (row.element() as HTMLElement).focus());
  await userEvent.hover(row);
  await userEvent.unhover(row);
  expect(onIntent).toHaveBeenLastCalledWith(entry);

  await userEvent.hover(row);
  await act(() => (row.element() as HTMLElement).blur());
  expect(onIntent).toHaveBeenLastCalledWith(entry);

  await userEvent.unhover(row);
  expect(onIntent).toHaveBeenLastCalledWith(null);
});
