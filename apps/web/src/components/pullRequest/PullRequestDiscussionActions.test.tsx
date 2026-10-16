import {
  EnvironmentId,
  ProjectId,
  type PullRequestComment,
  type PullRequestThreadStatus,
} from "@t3tools/contracts";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  allowed: true,
  run: vi.fn<(...args: unknown[]) => Promise<{ _tag: "Success" | "Failure" }>>(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.run }));
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    runHostAction: { permissionAtom: () => null },
    deleteComment: { permissionAtom: () => null },
    updateComment: { permissionAtom: () => null },
    setReaction: { permissionAtom: () => null },
    setThreadResolution: { permissionAtom: () => null },
  },
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/select", () => ({
  Select: "select",
  SelectTrigger: "button",
  SelectPopup: "div",
  SelectItem: "option",
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: "output",
}));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("~/hooks/useCopyToClipboard", () => ({ writeTextToClipboard: vi.fn() }));
vi.mock("../ui/menu", () => ({
  Menu: "menu",
  MenuItem: "menuitem",
  MenuPopup: "div",
  MenuTrigger: "trigger",
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? children : null,
  AlertDialogPopup: "dialog",
  AlertDialogHeader: "header",
  AlertDialogTitle: "h2",
  AlertDialogDescription: "p",
  AlertDialogFooter: "footer",
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
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = true;
  state.run.mockReset().mockResolvedValue({ _tag: "Success" });
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
it("preserves native states, reports failure, and refuses changes after permission is removed", async () => {
  const render = () => (
    <PullRequestDiscussionStatus {...props} threadId="7734" status="active" statuses={statuses} />
  );
  act(() => {
    renderer = create(render());
  });
  for (const status of statuses.slice(1)) {
    await act(async () => renderer!.root.findByType("select").props.onValueChange(status));
    expect(state.run).toHaveBeenLastCalledWith({
      environmentId: props.environmentId,
      input: { ...props.reference, threadId: "7734", status, resolved: status !== "pending" },
    });
  }
  state.run.mockResolvedValueOnce({ _tag: "Failure" });
  await act(async () => renderer!.root.findByType("select").props.onValueChange("fixed"));
  expect(renderer!.root.findByType("select").props.value).toBe("byDesign");
  expect(renderer!.root.findByProps({ role: "alert" })).toBeDefined();
  state.allowed = false;
  act(() => renderer!.update(render()));
  state.run.mockClear();
  await act(async () => renderer!.root.findByType("select").props.onValueChange("fixed"));
  expect(state.run).not.toHaveBeenCalled();
});
it("keeps a chosen status until activity reports it, then follows later changes", async () => {
  const render = (status: PullRequestThreadStatus, threadId = "7734") => (
    <PullRequestDiscussionStatus
      {...props}
      threadId={threadId}
      status={status}
      statuses={statuses}
    />
  );
  const select = () => renderer!.root.findByType("select").props;
  act(() => {
    renderer = create(render("active"));
  });
  const change = deferred();
  state.run.mockReturnValueOnce(change.promise);
  act(() => select().onValueChange("fixed"));
  expect(select()).toMatchObject({ value: "fixed", disabled: true });
  await act(async () => change.resolve({ _tag: "Success" }));
  expect(select()).toMatchObject({ value: "fixed", disabled: false });
  // The activity refreshed by the change has not arrived yet.
  act(() => renderer!.update(render("active")));
  expect(select().value).toBe("fixed");
  act(() => renderer!.update(render("fixed")));
  expect(select().value).toBe("fixed");
  // Somebody reactivates it later.
  act(() => renderer!.update(render("active")));
  expect(select().value).toBe("active");

  const refused = deferred();
  state.run.mockReturnValueOnce(refused.promise);
  act(() => select().onValueChange("wontFix"));
  expect(select().value).toBe("wontFix");
  await act(async () => refused.resolve({ _tag: "Failure" }));
  expect(select().value).toBe("active");
  expect(renderer!.root.findByProps({ role: "alert" })).toBeDefined();

  const overtaken = deferred();
  state.run.mockReturnValueOnce(overtaken.promise);
  act(() => select().onValueChange("closed"));
  act(() => renderer!.update(render("byDesign")));
  expect(select().value).toBe("byDesign");
  await act(async () => overtaken.resolve({ _tag: "Success" }));
  expect(select().value).toBe("byDesign");

  await act(async () => select().onValueChange("pending"));
  expect(select().value).toBe("pending");
  act(() => renderer!.update(render("byDesign", "other")));
  expect(select().value).toBe("byDesign");
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
it("requires deletion confirmation and permits retry after host refusal", async () => {
  act(() => {
    renderer = create(
      <PullRequestCommentActions
        {...props}
        comment={comment}
        canEdit
        canDelete
        canLike
        onEdit={() => {}}
      />,
    );
  });
  act(() => renderer!.root.findByProps({ "aria-label": "Delete comment" }).props.onClick());
  expect(state.run).not.toHaveBeenCalled();
  const confirm = () =>
    renderer!.root.findAllByType("button").find((node) => node.children.includes("Delete comment"));
  state.run.mockResolvedValueOnce({ _tag: "Failure" });
  await act(async () => confirm()!.props.onClick());
  expect(renderer!.root.findByProps({ role: "alert" })).toBeDefined();
  expect(confirm()).toBeDefined();
  await act(async () => confirm()!.props.onClick());
  expect(state.run).toHaveBeenLastCalledWith({
    environmentId: props.environmentId,
    input: { ...props.reference, commentId: "7734:3", kind: "review-comment" },
  });
  expect(confirm()).toBeUndefined();
  expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
});
it("disables comment actions the host denies, with its reason", () => {
  act(() => {
    renderer = create(
      <PullRequestReviewContext
        value={{
          ...props,
          azure: true,
          previousVisit: null,
          deniedActions: { "delete-comment": "Branch policy forbids deleting comments." },
        }}
      >
        <PullRequestCommentActions
          {...props}
          comment={comment}
          canEdit
          canDelete
          canLike
          onEdit={() => {}}
        />
      </PullRequestReviewContext>,
    );
  });
  const button = (label: string) =>
    renderer!.root.find((node) => node.type === "button" && node.props["aria-label"] === label);
  expect(button("Delete comment").props.disabled).toBe(true);
  expect(button("Edit comment").props.disabled).toBe(false);
  expect(renderer!.root.findByType("output").children).toEqual([
    "Branch policy forbids deleting comments.",
  ]);
});
