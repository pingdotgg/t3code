import { EnvironmentId, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ detail: null as unknown, error: null as unknown }));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data: atom === null ? null : state.detail,
    dataUpdatedAt: 0,
    error: atom === null ? null : state.error,
    failure: null,
    isPending: false,
    isSuccess: state.detail !== null,
    refresh: () => undefined,
  })) as never,
}));

import { render } from "../../../test/render";
import { IssueLinkPreview } from "./IssueLinkPreview";

const url = "https://github.com/owner/repo/issues/7";

function setup({ detail = null as unknown, error = null as unknown } = {}) {
  state.detail = detail;
  state.error = error;
}

function renderPreview() {
  return render(
    <IssueLinkPreview
      link={<a href={url}>#7</a>}
      originalUrl={url}
      target={{
        environmentId: EnvironmentId.make("environment"),
        input: {
          projectId: ProjectId.make("project"),
          tracker: IssueTrackerKind.make("github"),
          scope: "owner/repo",
          key: "7",
        },
      }}
    />,
  );
}

it("shows the issue's title, state and author on hover", async () => {
  setup({
    detail: {
      scope: "owner/repo",
      displayKey: "#7",
      title: "Hover cards for issues",
      state: { category: "closed", name: "Closed", closeReason: "completed" },
      author: { login: "octocat" },
      createdAt: "2026-08-01T00:00:00Z",
    },
  });
  await using screen = await renderPreview();

  await userEvent.hover(screen.getByRole("link"));

  await expect.element(page.getByText("Hover cards for issues")).toBeVisible();
  await expect.element(page.getByText("Closed", { exact: true })).toBeVisible();
  await expect.element(page.getByText("octocat")).toBeVisible();
});

it("falls back to the link's URL when the issue cannot be read", async () => {
  setup({ error: new Error("unavailable") });
  await using screen = await renderPreview();

  await userEvent.hover(screen.getByRole("link"));

  await expect.element(page.getByText(url)).toBeVisible();
});
