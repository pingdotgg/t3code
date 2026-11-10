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
    }) as PullRequestSummary,
);
const state = vi.hoisted(() => ({ restoredPreview: null as unknown, reads: [] as unknown[] }));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  // The host has not answered the preview read yet.
  useEnvironmentQuery: ((atom: unknown) => {
    state.reads.push(atom);
    return {
      data: state.restoredPreview,
      dataUpdatedAt: 0,
      error: null,
      failure: null,
      isPending: atom !== null,
      isSuccess: false,
      refresh: () => undefined,
    };
  }) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useSharedPullRequestSummary: (() => known) as never,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      detail: ((target: unknown) => ({ detail: target })) as never,
    },
  };
});

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
  await expect.element(page.getByText("Closed", { exact: true })).toBeVisible();
  expect(page.getByText("Known title").query()).toBeNull();
});

it("shows the known summary while the preview loads", async () => {
  state.restoredPreview = null;
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
});

it.each([
  ["a pull request URL", "https://github.com/owner/repo/pull/1"],
  // GitHub autolinks a bare #1 to its issues URL, which the panel opens as the pull request.
  ["a bare reference", "https://github.com/owner/repo/issues/1"],
])("reads the panel's detail once the preview of %s opens", async (_case, url) => {
  state.restoredPreview = null;
  state.reads = [];
  await using screen = await render(
    <PullRequestLinkPreview
      link={<a href={url}>#1</a>}
      originalUrl={url}
      target={{
        environmentId: EnvironmentId.make("environment"),
        input: { projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 },
      }}
    />,
  );
  expect(
    state.reads.filter((read) => read !== null && typeof read === "object" && "detail" in read),
  ).toEqual([]);

  await userEvent.hover(screen.getByRole("link"));
  await expect.element(page.getByText("Known title")).toBeVisible();

  // The panel a click opens reads the link's own host and repository.
  const reference = {
    projectId: ProjectId.make("project"),
    host: "github.com",
    repository: "owner/repo",
    number: 1,
  };
  const environmentId = EnvironmentId.make("environment");
  expect(state.reads).toContainEqual({
    detail: { environmentId, input: { ...reference, allowStale: false } },
  });
});
