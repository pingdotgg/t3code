import type { IssueDetail } from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const url = "https://github.com/owner/repo/issues/7";
const detail = vi.hoisted(() => ({
  tracker: "github",
  host: "github.com",
  scope: "owner/repo",
  key: "7",
  displayKey: "#7",
  title: "Something is broken",
  url: "https://github.com/owner/repo/issues/7",
  author: null,
  state: { category: "open", name: "Open" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  closedAt: null,
  assignees: [],
  labels: [],
  commentCount: 0,
  projectId: "project-1",
  projectTitle: "Project",
  writable: true,
  capabilities: {
    create: false,
    edit: true,
    comment: false,
    labels: true,
    assignees: true,
    reactions: false,
    templates: false,
    linkedPullRequests: false,
    events: false,
    search: false,
  },
  viewerPermissions: {
    setState: false,
    comment: false,
    edit: true,
    labels: true,
    assignees: true,
  },
  states: [],
  viewer: null,
  body: "",
  comments: [],
  commentsCursor: null,
  events: [],
  linkedPullRequests: [],
})) as unknown as IssueDetail;

const state = vi.hoisted(() => ({
  openLink: vi.fn(async () => {}),
  comment: vi.fn(async (_value: unknown) => ({ _tag: "Success" })),
}));

vi.mock(import("~/browser/useOpenLink"), () => ({ useOpenLink: () => state.openLink }));
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const actual = await original();
  const { issueEnvironment } = await import("~/state/issues");
  return {
    useAtomCommand: ((command, options) =>
      command.label === issueEnvironment.comment.label
        ? state.comment
        : actual.useAtomCommand(command, options)) as typeof actual.useAtomCommand,
  };
});
vi.mock(import("./IssueThreadLinks"), () => ({ IssueThreadLinks: (() => null) as never }));
vi.mock(import("~/state/issues"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await original();
  const detailAtom = Atom.make(AsyncResult.success(detail));
  const serviceDeskAtom = Atom.make(
    AsyncResult.success({
      ...detail,
      tracker: "jira",
      host: "example.atlassian.net",
      scope: "SUP",
      key: "SUP-12",
      displayKey: "SUP-12",
      url: "https://example.atlassian.net/browse/SUP-12",
      capabilities: { ...detail.capabilities, comment: true },
      viewerPermissions: { ...detail.viewerPermissions, comment: true },
      commentAudiences: true,
    }),
  );
  const candidatesAtom = Atom.make(
    AsyncResult.success({
      labels: [
        { name: "bug", color: "d73a4a", description: null },
        { name: "docs", color: "0075ca", description: null },
      ],
      assignees: [
        { id: "1", login: "alice", name: null, avatarUrl: null },
        { id: "2", login: "bob", name: null, avatarUrl: null },
      ],
      truncated: false,
    }),
  );
  const allowed = Atom.make(true);
  return {
    ...actual,
    issueEnvironment: {
      ...actual.issueEnvironment,
      detail: (({ input }: { input: { key: string } }) =>
        input.key === "SUP-12" ? serviceDeskAtom : detailAtom) as never,
      candidates: (() => candidatesAtom) as never,
      comment: { ...actual.issueEnvironment.comment, permissionAtom: () => allowed },
    },
  };
});

import { RightPanelSheet } from "../RightPanelSheet";
import { IssueDetailPanel } from "./IssueDetailPanel";

const reference = {
  projectId: "project-1" as never,
  tracker: "github" as never,
  scope: "owner/repo",
  key: "7",
};

function setComments(comments: IssueDetail["comments"]) {
  state.openLink.mockClear();
  (detail as { comments: unknown }).comments = comments;
}

describe("IssueDetailPanel", () => {
  it("opens the issue number through the link-target setting, not a popup", async () => {
    setComments([]);
    const threadRef = { environmentId: "env-1", threadId: "thread-1" } as never;
    await using screen = await render(
      <IssueDetailPanel
        environmentId={"env-1" as never}
        reference={reference}
        threadRef={threadRef}
      />,
    );
    const number = screen.getByRole("link", { name: "Open #7 on GitHub" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    (await number.element()).dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(state.openLink).toHaveBeenCalledOnce();
    expect(state.openLink).toHaveBeenCalledWith(url, { event: expect.anything() });
  });

  it("opens a comment's timestamp through the link-target setting, not a popup", async () => {
    const commentUrl = `${url}#issuecomment-1`;
    setComments([
      {
        id: "1",
        author: null,
        body: "Same here",
        createdAt: "2026-01-02T00:00:00.000Z",
        url: commentUrl,
      },
    ]);
    await using screen = await render(
      <IssueDetailPanel
        environmentId={"env-1" as never}
        reference={reference}
        threadRef={{ environmentId: "env-1", threadId: "thread-1" } as never}
      />,
    );
    const link = await vi.waitFor(() => {
      const found = screen.container.querySelector(`a[href="${commentUrl}"]`);
      expect(found).not.toBeNull();
      return found!;
    });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(state.openLink).toHaveBeenCalledOnce();
    expect(state.openLink).toHaveBeenCalledWith(commentUrl, { event: expect.anything() });
  });

  it("Escape cancels the title edit without closing the right panel sheet", async () => {
    setComments([]);
    const onCloseSheet = vi.fn();
    await using _screen = await render(
      <RightPanelSheet animationDurationMs={0} open onClose={onCloseSheet}>
        <IssueDetailPanel environmentId={"env-1" as never} reference={reference} />
      </RightPanelSheet>,
    );
    await act(() =>
      (page.getByRole("button", { name: "Edit title" }).element() as HTMLElement).click(),
    );
    const input = page.getByRole("textbox", { name: "Issue title" });
    await expect.element(input).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    await expect.element(input).not.toBeInTheDocument();
    expect(onCloseSheet).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(onCloseSheet).toHaveBeenCalledTimes(1);
  });

  it("finds a label when the search has surrounding spaces", async () => {
    setComments([]);
    await using screen = await render(
      <IssueDetailPanel environmentId={"env-1" as never} reference={reference} />,
    );
    await screen.getByRole("combobox", { name: "Change labels" }).click();
    await userEvent.fill(page.getByRole("combobox", { name: "Search labels" }), " bug ");

    await expect.element(page.getByRole("option", { name: "bug" })).toBeInTheDocument();
    await expect.element(page.getByRole("option", { name: "docs" })).not.toBeInTheDocument();
  });

  it("finds an assignee when the search has surrounding spaces", async () => {
    setComments([]);
    await using screen = await render(
      <IssueDetailPanel environmentId={"env-1" as never} reference={reference} />,
    );
    await screen.getByRole("combobox", { name: "Change assignees" }).click();
    await userEvent.fill(page.getByRole("combobox", { name: "Search people" }), " alice ");

    await expect.element(page.getByRole("option", { name: "alice" })).toBeInTheDocument();
    await expect.element(page.getByRole("option", { name: "bob" })).not.toBeInTheDocument();
  });

  it("goes back to an internal note after a reply to the customer is posted", async () => {
    state.comment.mockClear();
    await using _screen = await render(
      <IssueDetailPanel
        environmentId={"env-1" as never}
        reference={{ ...reference, tracker: "jira" as never, scope: "SUP", key: "SUP-12" }}
      />,
    );
    const field = page.getByRole("textbox", { name: "Add a comment" });
    const send = page.getByRole("button", { name: "Comment", exact: true });

    await page.getByRole("button", { name: "Internal note" }).click();
    await page.getByRole("menuitemradio", { name: "Reply to customer" }).click();
    await userEvent.fill(field, "We have shipped a fix.");
    await send.click();
    await expect.element(page.getByRole("button", { name: "Internal note" })).toBeInTheDocument();
    await userEvent.fill(field, "Customer confirmed on a call.");
    await send.click();
    await vi.waitFor(() =>
      expect(
        state.comment.mock.calls.map(
          ([value]) => (value as { input: { audience?: string } }).input.audience,
        ),
      ).toEqual(["public", "internal"]),
    );
  });
});
