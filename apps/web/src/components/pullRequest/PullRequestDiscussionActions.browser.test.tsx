import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestComment,
  type PullRequestThreadStatus,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { act, render as renderUi } from "../../../test/render";

const state = vi.hoisted(() => ({
  permission: null as Atom.Writable<boolean> | null,
  run: vi.fn<(...args: unknown[]) => Promise<{ _tag: "Success" | "Failure" }>>(),
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.run) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      runHostAction: {
        ...actual.pullRequestEnvironment.runHostAction,
        permissionAtom: () => state.permission!,
      },
      deleteComment: {
        ...actual.pullRequestEnvironment.deleteComment,
        permissionAtom: () => state.permission!,
      },
      updateComment: {
        ...actual.pullRequestEnvironment.updateComment,
        permissionAtom: () => state.permission!,
      },
      setReaction: {
        ...actual.pullRequestEnvironment.setReaction,
        permissionAtom: () => state.permission!,
      },
      setThreadResolution: {
        ...actual.pullRequestEnvironment.setThreadResolution,
        permissionAtom: () => state.permission!,
      },
    },
  };
});
vi.mock(import("~/browser/useOpenLink"), async (original) => ({
  ...(await original()),
  useOpenLink: () => vi.fn(),
}));

import { PullRequestDiscussionStatus } from "./PullRequestDiscussionStatus";
import { PullRequestCommentActions } from "./PullRequestCommentActions";
import { PullRequestReviewContext } from "./PullRequestReviewContext";

const props = {
  environmentId: EnvironmentId.make("environment"),
  reference: {
    projectId: ProjectId.make("project"),
    host: "dev.azure.com",
    repository: "review-demo",
    number: 1336,
  },
};
function deferred() {
  let resolve!: (value: { _tag: "Success" | "Failure" }) => void;
  const promise = new Promise<{ _tag: "Success" | "Failure" }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const statuses: PullRequestThreadStatus[] = [
  "active",
  "pending",
  "fixed",
  "wontFix",
  "closed",
  "byDesign",
];

function setup() {
  state.permission = Atom.make(true);
  const registry = AtomRegistry.make();
  state.run.mockReset().mockResolvedValue({ _tag: "Success" });

  return {
    registry,
    wrap: (node: ReactNode) => (
      <RegistryContext.Provider value={registry}>{node}</RegistryContext.Provider>
    ),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

const statusNode = (status: PullRequestThreadStatus = "active", threadId = "7734") => (
  <PullRequestDiscussionStatus {...props} threadId={threadId} status={status} statuses={statuses} />
);
const statusLabels: Record<PullRequestThreadStatus, string> = {
  active: "Active",
  pending: "Pending",
  fixed: "Resolved",
  wontFix: "Won’t fix",
  closed: "Closed",
  byDesign: "By design",
};
const statusControl = () => page.getByRole("combobox", { name: "Discussion status" });
const selectStatus = async (status: PullRequestThreadStatus) => {
  await statusControl().click();
  await page.getByRole("option", { name: statusLabels[status], exact: true }).click();
};

it("preserves native states, reports failure, and refuses changes after permission is removed", async () => {
  using fixture = setup();
  await using _screen = await renderUi(fixture.wrap(statusNode()));
  for (const status of statuses.slice(1)) {
    await selectStatus(status);
    expect(state.run).toHaveBeenLastCalledWith({
      environmentId: props.environmentId,
      input: { ...props.reference, threadId: "7734", status, resolved: status !== "pending" },
    });
  }
  state.run.mockResolvedValueOnce({ _tag: "Failure" });
  await selectStatus("fixed");
  await expect.element(statusControl()).toHaveTextContent("By design");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Could not update discussion status.");
  await act(async () => fixture.registry.set(state.permission!, false));
  state.run.mockClear();
  await expect.element(statusControl()).toBeDisabled();
  await act(async () => (statusControl().element() as HTMLButtonElement).click());
  await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
  expect(state.run).not.toHaveBeenCalled();
});

it("keeps a chosen status until activity reports it, then follows later changes", async () => {
  using fixture = setup();
  await using screen = await renderUi(fixture.wrap(statusNode()));
  const change = deferred();
  state.run.mockReturnValueOnce(change.promise);
  await selectStatus("fixed");
  await expect.element(statusControl()).toHaveTextContent("Resolved");
  await expect.element(statusControl()).toBeDisabled();
  await act(async () => change.resolve({ _tag: "Success" }));
  await expect.element(statusControl()).toBeEnabled();
  await screen.rerender(fixture.wrap(statusNode("active")));
  await expect.element(statusControl()).toHaveTextContent("Resolved");
  await screen.rerender(fixture.wrap(statusNode("fixed")));
  await expect.element(statusControl()).toHaveTextContent("Resolved");
  await screen.rerender(fixture.wrap(statusNode("active")));
  await expect.element(statusControl()).toHaveTextContent("Active");

  const refused = deferred();
  state.run.mockReturnValueOnce(refused.promise);
  await selectStatus("wontFix");
  await expect.element(statusControl()).toHaveTextContent("Won’t fix");
  await act(async () => refused.resolve({ _tag: "Failure" }));
  await expect.element(statusControl()).toHaveTextContent("Active");
  await expect.element(page.getByRole("alert")).toBeVisible();

  const overtaken = deferred();
  state.run.mockReturnValueOnce(overtaken.promise);
  await selectStatus("closed");
  await screen.rerender(fixture.wrap(statusNode("byDesign")));
  await expect.element(statusControl()).toHaveTextContent("By design");
  await act(async () => overtaken.resolve({ _tag: "Success" }));
  await expect.element(statusControl()).toHaveTextContent("By design");

  await selectStatus("pending");
  await expect.element(statusControl()).toHaveTextContent("Pending");
  await screen.rerender(fixture.wrap(statusNode("byDesign", "other")));
  await expect.element(statusControl()).toHaveTextContent("By design");
});

const comment: PullRequestComment = {
  id: "7734:3",
  kind: "review-comment",
  author: null,
  body: "Test",
  createdAt: "2026-10-15T12:00:00Z",
  url: null,
  path: null,
  reviewState: null,
};
const commentActions = () => (
  <PullRequestCommentActions
    {...props}
    comment={comment}
    canEdit
    canDelete
    canLike
    onEdit={() => {}}
  />
);

it("requires deletion confirmation and permits retry after host refusal", async () => {
  using fixture = setup();
  await using _screen = await renderUi(fixture.wrap(commentActions()));
  await page.getByRole("button", { name: "Delete comment", exact: true }).click();
  expect(state.run).not.toHaveBeenCalled();
  const confirmation = page.getByRole("alertdialog", { name: "Delete comment?" });
  const confirm = confirmation.getByRole("button", { name: "Delete comment", exact: true });
  state.run.mockResolvedValueOnce({ _tag: "Failure" });
  await confirm.click();
  await expect
    .element(confirmation.getByRole("alert"))
    .toHaveTextContent("Could not delete the comment.");
  await expect.element(confirm).toBeEnabled();
  await confirm.click();
  expect(state.run).toHaveBeenLastCalledWith({
    environmentId: props.environmentId,
    input: { ...props.reference, commentId: "7734:3", kind: "review-comment" },
  });
  await expect.element(confirmation).not.toBeInTheDocument();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
});

it("disables comment actions the host denies, with its reason", async () => {
  using fixture = setup();
  await using _screen = await renderUi(
    fixture.wrap(
      <PullRequestReviewContext
        value={{
          ...props,
          azure: true,
          previousVisit: null,
          deniedActions: { "delete-comment": "Branch policy forbids deleting comments." },
        }}
      >
        {commentActions()}
      </PullRequestReviewContext>,
    ),
  );
  await expect
    .element(page.getByRole("button", { name: "Delete comment", exact: true }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Edit comment", exact: true }))
    .toBeEnabled();
  await expect
    .element(page.getByText("Branch policy forbids deleting comments.", { exact: true }))
    .toBeInTheDocument();
});
