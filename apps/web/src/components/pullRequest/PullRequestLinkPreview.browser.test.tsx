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
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  // The host has not answered the preview read yet.
  useEnvironmentQuery: ((atom: unknown) => ({
    data: null,
    dataUpdatedAt: 0,
    error: null,
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

it("shows the known summary while the preview loads", async () => {
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
