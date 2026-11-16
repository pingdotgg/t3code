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
interface Read {
  data: unknown;
  error: string | null;
}
const state = vi.hoisted(() => ({
  preview: { data: null, error: null } as Read,
  activity: { data: null, error: null } as Read,
}));
function setup(preview: Partial<Read>, activity: Partial<Read> = {}) {
  state.preview = { data: null, error: null, ...preview };
  state.activity = { data: null, error: null, ...activity };
}
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => {
    const read = atom === null ? { data: null, error: null } : state[atom as keyof typeof state];
    return {
      data: read.data,
      dataUpdatedAt: 0,
      error: read.error,
      failure: null,
      isPending: atom !== null && read.data === null && read.error === null,
      isSuccess: false,
      refresh: () => undefined,
    };
  }) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      previewCard: () => "preview",
      activity: () => "activity",
    } as never,
    useSharedPullRequestSummary: (() => known) as never,
  };
});

import { render } from "../../../test/render";
import { PullRequestLinkPreview } from "./PullRequestLinkPreview";

const loadedPreview = {
  projectId: "project",
  repository: "owner/repo",
  number: 1,
  title: "Known title",
  url: known.url,
  author: { login: "octocat" },
  state: "open",
  isDraft: false,
  createdAt: "2026-08-01T00:00:00Z",
};

function renderPreview(url = known.url) {
  return render(
    <PullRequestLinkPreview
      link={<a href={url}>#1</a>}
      originalUrl={url}
      target={{
        environmentId: EnvironmentId.make("environment"),
        input: { projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 },
      }}
    />,
  );
}

it("keeps a refreshing preview's state and title over an older known summary", async () => {
  setup({ data: { ...loadedPreview, title: "Renamed title", state: "closed" } });
  await using screen = await renderPreview();

  await userEvent.hover(screen.getByRole("link"));

  await expect.element(page.getByText("Renamed title")).toBeVisible();
  await expect.element(page.getByLabelText("Closed", { exact: true })).toBeInTheDocument();
  expect(page.getByText("Known title").query()).toBeNull();
});

it("shows the known summary while the preview loads", async () => {
  setup({});
  await using screen = await renderPreview();

  await userEvent.hover(screen.getByRole("link"));

  await expect.element(page.getByText("Known title")).toBeVisible();
  expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();
});

it("drops the opened placeholder when the preview fails", async () => {
  setup({ error: "Preview failed" });
  await using screen = await renderPreview();

  await userEvent.hover(screen.getByRole("link"));

  await expect.element(page.getByText("Known title")).toBeVisible();
  expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();
});

it.each([
  [`${known.url}#issuecomment-1`, true],
  [`${known.url}/commits/${"a".repeat(40)}`, true],
  [`${known.url}#event-1`, false],
])("holds the place of the comment or commit %s links to while it loads", async (url, held) => {
  setup({ data: loadedPreview });
  await using screen = await renderPreview(url);

  await userEvent.hover(screen.getByRole("link"));

  await expect.element(page.getByText("owner/repo")).toBeVisible();
  expect(page.getByText("Known title").query() === null).toBe(held);
  expect(document.querySelector('[data-slot="skeleton"]') !== null).toBe(held);
});

it("falls back to the pull request when the linked comment fails to load", async () => {
  setup({ data: loadedPreview }, { error: "Activity failed" });
  await using screen = await renderPreview(`${known.url}#issuecomment-1`);

  await userEvent.hover(screen.getByRole("link"));

  await expect.element(page.getByText("Known title")).toBeVisible();
  expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();
});
