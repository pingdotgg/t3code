import { Atom } from "effect/reactivity";
import { EnvironmentId, IssueTrackerKind, ProjectId, type IssueDetail } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ detail: null as IssueDetail | null }));

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: state.detail,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: state.detail !== null,
    refresh: () => undefined,
  })) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [],
  useThreads: () => [],
}));
vi.mock(import("@t3tools/client-runtime/state/issues"), async (original) => ({
  ...(await original()),
  createIssueCommentPager: () => ({
    view: Atom.make({
      comments: state.detail?.comments ?? [],
      nextCursor: null,
      loadingOlder: false,
      canLoadOlder: false,
    }),
    loadOlder: async () => {},
    refresh: async () => {},
  }),
}));

import { render } from "../../../test/render";
import { IssueDetailPanel } from "./IssueDetailPanel";

function makeIssue(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    projectId: ProjectId.make("project-1"),
    projectTitle: "t3code",
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "pingdotgg/t3code",
    key: "42686",
    displayKey: "#42686",
    url: "https://github.com/pingdotgg/t3code/issues/42686",
    title: "Issue reference autolinks",
    body: "Fix opened in #38661.",
    state: { category: "open", name: "Open" },
    states: [{ category: "open", name: "Open" }],
    writable: false,
    capabilities: {
      create: false,
      edit: false,
      comment: false,
      labels: false,
      assignees: false,
      reactions: false,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: false,
    },
    viewerPermissions: {
      setState: false,
      comment: false,
      edit: false,
      labels: false,
      assignees: false,
    },
    viewer: null,
    author: { login: "octocat", name: null, avatarUrl: null },
    assignees: [],
    labels: [],
    createdAt: "2026-11-25T00:00:00Z",
    updatedAt: "2026-11-25T00:00:00Z",
    closedAt: null,
    commentCount: 1,
    comments: [
      {
        id: "comment-1",
        author: { login: "octocat", name: null, avatarUrl: null },
        body: "Also see #41322 and abcdef1.",
        createdAt: "2026-11-25T01:00:00Z",
        url: "https://github.com/pingdotgg/t3code/issues/42686#issuecomment-1",
      },
    ],
    commentsCursor: null,
    events: [],
    linkedPullRequests: [],
    ...overrides,
  };
}

describe("IssueDetailPanel markdown references", () => {
  it("autolinks GitHub shorthand references in issue descriptions and comments", async () => {
    const detail = makeIssue();
    state.detail = detail;
    await using screen = await render(
      <IssueDetailPanel
        environmentId={EnvironmentId.make("env-1")}
        reference={{
          projectId: detail.projectId,
          tracker: detail.tracker,
          host: detail.host,
          scope: detail.scope,
          key: detail.key,
        }}
      />,
    );

    const prLink = screen.getByRole("link", { name: "#38661" }).element();
    expect(prLink.getAttribute("href")).toBe("https://github.com/pingdotgg/t3code/issues/38661");
    expect(prLink.getAttribute("data-pull-request-autolink")).toBe("reference");

    const commentRef = screen.getByRole("link", { name: "#41322" }).element();
    expect(commentRef.getAttribute("href")).toBe(
      "https://github.com/pingdotgg/t3code/issues/41322",
    );
    expect(commentRef.getAttribute("data-pull-request-autolink")).toBe("reference");

    const commitRef = screen.getByRole("link", { name: "abcdef1" }).element();
    expect(commitRef.getAttribute("href")).toBe(
      "https://github.com/pingdotgg/t3code/commit/abcdef1",
    );
    expect(commitRef.getAttribute("data-pull-request-autolink")).toBe("commit");
  });

  it("leaves #123 as plain text for standalone issue trackers such as Linear", async () => {
    const detail = makeIssue({
      tracker: IssueTrackerKind.make("linear"),
      host: "linear.app",
      scope: "ENG",
      key: "ENG-1",
      displayKey: "ENG-1",
      url: "https://linear.app/acme/issue/ENG-1",
      body: "Tracks #38661.",
      comments: [],
      commentCount: 0,
    });
    state.detail = detail;
    await using screen = await render(
      <IssueDetailPanel
        environmentId={EnvironmentId.make("env-1")}
        reference={{
          projectId: detail.projectId,
          tracker: detail.tracker,
          host: detail.host,
          scope: detail.scope,
          key: detail.key,
        }}
      />,
    );

    await expect.element(screen.getByText("Tracks #38661.")).toBeVisible();
    expect(screen.getByRole("link", { name: "#38661" }).query()).toBeNull();
  });
});
