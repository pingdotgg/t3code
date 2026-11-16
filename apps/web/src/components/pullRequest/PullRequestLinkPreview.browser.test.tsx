import { EnvironmentId, ProjectId, type PullRequestSummary } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const known = vi.hoisted(
  () =>
    ({
      provider: "github",
      projectId: "project",
      repository: "owner/repo",
      number: 1,
      title: "Known title",
      url: "https://github.com/owner/repo/pull/1",
      state: "open",
      headBranch: "feature",
      baseBranch: "main",
      updatedAt: "2026-09-01T00:00:00Z",
      author: { login: "octocat" },
    }) as PullRequestSummary,
);
const state = vi.hoisted(() => ({
  restoredPreview: null as unknown,
  error: null as string | null,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  // The host has not answered the preview read yet.
  useEnvironmentQuery: ((atom: unknown) => ({
    data: state.restoredPreview,
    dataUpdatedAt: 0,
    error: state.error,
    failure: null,
    isPending: atom !== null,
    isSuccess: false,
    refresh: () => undefined,
  })) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => ({
  ...(await original()),
  useSharedPullRequestSummary: (() => known) as never,
}));

import { render } from "../../../test/render";
import { PullRequestLinkPreview } from "./PullRequestLinkPreview";

function renderPreview() {
  return render(
    <PullRequestLinkPreview
      link={<a href={known.url}>#1</a>}
      originalUrl={known.url}
      target={{
        environmentId: EnvironmentId.make("environment"),
        input: { projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 },
      }}
    />,
  );
}

it("keeps a refreshing preview's state and title over an older known summary", async () => {
  state.error = null;
  state.restoredPreview = {
    projectId: "project",
    repository: "owner/repo",
    number: 1,
    title: "Renamed title",
    url: known.url,
    author: { login: "octocat" },
    state: "closed",
    isDraft: false,
    createdAt: "2026-08-01T00:00:00Z",
  };
  await using screen = await renderPreview();

  await userEvent.hover(screen.getByRole("link"));

  await expect.element(page.getByText("Renamed title")).toBeVisible();
  await expect.element(page.getByLabelText("Closed", { exact: true })).toBeInTheDocument();
  expect(page.getByText("Known title").query()).toBeNull();
});

it("shows the known summary while the preview loads", async () => {
  state.restoredPreview = null;
  state.error = null;
  await using screen = await render(
    <PullRequestLinkPreview
      link={<a href={known.url}>#1</a>}
      originalUrl={known.url}
      target={{
        environmentId: EnvironmentId.make("environment"),
        input: { projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 },
      }}
    />,
  );

  await userEvent.hover(screen.getByRole("link"));

  await expect.element(page.getByText("Known title")).toBeVisible();
  expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();
});

it("drops the opened placeholder when the preview fails", async () => {
  state.restoredPreview = null;
  state.error = "Preview failed";
  await using screen = await renderPreview();

  await userEvent.hover(screen.getByRole("link"));

  await expect.element(page.getByText("Known title")).toBeVisible();
  expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();
});
