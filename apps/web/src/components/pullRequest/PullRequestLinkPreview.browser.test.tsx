import { EnvironmentId, ProjectId, type PullRequestSummary } from "@t3tools/contracts";
import { getTranslationsSnapshot, GTProvider } from "gt-react";
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
const state = vi.hoisted(() => ({ restoredPreview: null as unknown, activity: null as unknown }));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  // The host has not answered the preview read yet.
  useEnvironmentQuery: ((atom: unknown) => ({
    data:
      atom === null
        ? null
        : typeof atom === "object" && "activity" in atom
          ? state.activity
          : state.restoredPreview,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: atom !== null,
    isSuccess: false,
    refresh: () => undefined,
  })) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useSharedPullRequestSummary: (() => known) as never,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      activity: ((target: unknown) => ({ activity: target })) as never,
    },
  };
});

import { initializeI18n } from "~/i18n/initializeI18n";
import { render } from "../../../test/render";
import { PullRequestLinkPreview } from "./PullRequestLinkPreview";

function setup(next: Partial<typeof state> = {}) {
  Object.assign(state, { restoredPreview: null, activity: null }, next);
  // GTProvider leaves its locale in a cookie; this sets it back to English.
  initializeI18n(() => {});
}

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
  setup({
    restoredPreview: {
      projectId: "project",
      repository: "owner/repo",
      number: 1,
      title: "Renamed title",
      url: known.url,
      author: { login: "octocat" },
      state: "closed",
      isDraft: false,
      createdAt: "2026-08-01T00:00:00Z",
    },
  });
  await using screen = await renderPreview();

  await userEvent.hover(screen.getByRole("link"));

  await expect.element(page.getByText("Renamed title")).toBeVisible();
  await expect.element(page.getByText("Closed", { exact: true })).toBeVisible();
  expect(page.getByText("Known title").query()).toBeNull();
});

it("shows the known summary while the preview loads", async () => {
  setup();
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

it("shows who commented on a linked comment in the active language", async () => {
  const commentUrl = `${known.url}#issuecomment-2`;
  setup({
    activity: {
      comments: [
        {
          id: "comment-2",
          kind: "issue-comment",
          author: { login: "octocat" },
          body: "Looks good",
          createdAt: "2026-09-01T00:00:00Z",
          url: commentUrl,
          path: null,
          reviewState: null,
        },
      ],
      reviewThreads: [],
      commits: [],
    },
  });
  const translations = await getTranslationsSnapshot("ja");
  await using screen = await render(
    <GTProvider locale="ja" translations={translations}>
      <PullRequestLinkPreview
        link={<a href={commentUrl}>#1</a>}
        originalUrl={commentUrl}
        target={{
          environmentId: EnvironmentId.make("environment"),
          input: { projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 },
        }}
      />
    </GTProvider>,
  );

  await userEvent.hover(screen.getByRole("link"));

  await expect.element(page.getByText(/octocat\s*がコメントしました/)).toBeVisible();
});
