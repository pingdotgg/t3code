import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestPreview,
  type PullRequestSummary,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  preview: null as PullRequestPreview | null,
  summary: null as PullRequestSummary | null,
  readPreview: vi.fn(),
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data: atom === null ? null : state.preview,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: atom !== null && state.preview === null,
    isSuccess: atom !== null && state.preview !== null,
    refresh: () => undefined,
  })) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => ({
  ...(await original()),
  useSharedPullRequestSummary: (() => state.summary) as never,
}));
vi.mock(import("~/state/use-atom-query-runner"), () => ({
  useAtomQueryRunner: (() => state.readPreview) as never,
}));

import { render } from "../../../test/render";
import { PullRequestLinkPreview } from "./PullRequestLinkPreview";

const projectId = ProjectId.make("project");
const url = "https://github.com/owner/repo/pull/1";

function setup({
  preview = null,
  summary = null,
}: {
  preview?: PullRequestPreview | null;
  summary?: PullRequestSummary | null;
}) {
  state.preview = preview;
  state.summary = summary;
  state.readPreview = vi.fn(() => new Promise(() => undefined));
}

function renderLink(onOpenPullRequest = vi.fn(() => true)) {
  return render(
    <PullRequestLinkPreview
      link={<a href={url}>#1</a>}
      originalUrl={url}
      target={{
        environmentId: EnvironmentId.make("environment"),
        input: { projectId, repository: "owner/repo", number: 1 },
      }}
      confirmBeforeOpen
      onOpenPullRequest={onOpenPullRequest}
    />,
  );
}

it("shows the shared summary while the preview loads", async () => {
  setup({
    summary: {
      provider: SourceControlProviderKind.make("github"),
      projectId,
      repository: "owner/repo",
      number: 1,
      title: "Known title",
      url,
      state: "open",
      headBranch: "feature",
      baseBranch: "main",
      updatedAt: "2026-09-01T00:00:00Z",
    },
  });
  await using screen = await renderLink();

  await userEvent.hover(screen.getByRole("link"));

  await expect.element(page.getByText("Known title")).toBeVisible();
});

it("opens a pull request the hover card already loaded without reading it again", async () => {
  setup({
    preview: {
      projectId,
      repository: "owner/repo",
      number: 1,
      title: "Loaded title",
      url,
      author: null,
      state: "open",
      isDraft: false,
      createdAt: "2026-09-01T00:00:00Z",
    },
  });
  const onOpenPullRequest = vi.fn(() => true);
  await using screen = await renderLink(onOpenPullRequest);
  await userEvent.hover(screen.getByRole("link"));
  await expect.element(page.getByText("Loaded title")).toBeVisible();

  await userEvent.click(screen.getByRole("link"));

  expect(onOpenPullRequest).toHaveBeenCalledWith(url);
  expect(state.readPreview).not.toHaveBeenCalled();
});
