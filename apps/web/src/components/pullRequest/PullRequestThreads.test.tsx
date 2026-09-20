import {
  EnvironmentId,
  ProjectId,
  type PullRequestDetailView,
  type PullRequestReviewThread,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({
  reply: vi.fn(),
  edit: vi.fn(),
  resolve: vi.fn(),
  load: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: {
    replyToThread: "reply",
    updateComment: "edit",
    setThreadResolution: "resolve",
    threadComments: "load",
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (key: keyof typeof commands) => commands[key],
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: commands.toast } }));
vi.mock("./PullRequestMarkdown", () => ({
  PullRequestMarkdown: ({ text }: { text: string }) => <p>{text}</p>,
}));
vi.mock("./PullRequestReactions", () => ({ PullRequestReactionBar: () => null }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipPopup: () => null,
}));
vi.mock("../ui/menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: () => null,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => children,
  DropdownMenuItem: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

import { PullRequestThreads } from "./PullRequestThreads";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";
import { PendingReviewCommentCard } from "./PullRequestReviewAnnotation";
import { usePullRequestReviewStore } from "./pullRequestReviewStore";

const thread: PullRequestReviewThread = {
  id: "thread-one",
  path: "src/main.ts",
  line: 4,
  side: "right",
  isResolved: false,
  isOutdated: false,
  comments: [
    {
      id: "comment-one",
      body: "Original comment",
      author: { login: "author", name: null, avatarUrl: null },
      createdAt: "2026-09-01T00:00:00Z",
      url: null,
    },
  ],
};
const detail: PullRequestDetailView = {
  provider: "github",
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Review",
  body: "Description",
  url: "https://github.com/owner/repo/pull/1",
  viewer: "author",
  author: { login: "author", name: null, avatarUrl: null },
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [thread],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: true,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: true },
  },
  viewerPermissions: {
    actions: [],
    comment: true,
    resolve: true,
    verdicts: [],
    requestReviewers: false,
  },
};
const environmentId = EnvironmentId.make("environment");
const reference = { projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 };
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
}
function button(label: string) {
  return renderer.root.findAllByType("button").find((node) => text(node) === label)!;
}
function render(value = detail, pending = false) {
  act(() => {
    renderer = create(
      <PullRequestThreads
        detail={value}
        environmentId={environmentId}
        reference={reference}
        onRefresh={commands.refresh}
        pending={pending}
      />,
    );
  });
}
function write(value: string) {
  act(() =>
    renderer.root
      .findByType("textarea")
      .props.onChange({ target: { value }, currentTarget: { value }, nativeEvent: {} }),
  );
}
function filter(value: string) {
  act(() =>
    renderer.root
      .findByProps({ "aria-label": "Filter review threads" })
      .props.onValueChange([value]),
  );
}

it("keeps a reply through failure, cancellation, and filter changes, then sends it once", async () => {
  render();
  act(() => button("Reply…").props.onClick());
  write("Keep this reply");
  commands.reply.mockResolvedValueOnce({ _tag: "Failure" });
  await act(async () => button("Reply").props.onClick());
  expect(renderer.root.findByType("textarea").props.value).toBe("Keep this reply");
  expect(text(renderer.root.findByProps({ role: "alert" }))).toContain("Your draft is still here");
  filter("resolved");
  filter("open");
  expect(renderer.root.findByType("textarea").props.value).toBe("Keep this reply");
  act(() => button("Cancel").props.onClick());
  act(() => button("Continue reply").props.onClick());
  expect(renderer.root.findByType("textarea").props.value).toBe("Keep this reply");
  commands.reply.mockResolvedValueOnce({ _tag: "Success" });
  await act(async () => {
    button("Reply").props.onClick();
    button("Reply").props.onClick();
  });
  expect(commands.reply).toHaveBeenCalledTimes(2);
  expect(commands.reply).toHaveBeenLastCalledWith({
    environmentId,
    input: { ...reference, threadId: thread.id, body: "Keep this reply" },
  });
  expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  expect(commands.refresh).toHaveBeenCalledOnce();
});

it("retains failed edits across collapse and routes the retry to its host thread", async () => {
  render();
  act(() => button("Edit comment").props.onClick());
  write("Edited text");
  const collapse = renderer.root
    .findAllByType("button")
    .find((node) => node.props["aria-expanded"] === true)!;
  act(() => collapse.props.onClick());
  act(() => collapse.props.onClick());
  expect(renderer.root.findByType("textarea").props.value).toBe("Edited text");
  commands.edit.mockResolvedValueOnce({ _tag: "Failure" });
  await act(async () => button("Save").props.onClick());
  expect(renderer.root.findByType("textarea").props.value).toBe("Edited text");
  commands.edit.mockResolvedValueOnce({ _tag: "Success" });
  await act(async () => button("Save").props.onClick());
  expect(commands.edit).toHaveBeenLastCalledWith({
    environmentId,
    input: {
      ...reference,
      threadId: thread.id,
      commentId: "comment-one",
      kind: "review-comment",
      body: "Edited text",
    },
  });
  expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
});

it("pages threads on request and keeps general discussions distinct from files", () => {
  render({
    ...detail,
    reviewThreads: Array.from({ length: 12 }, (_, index) => ({
      ...thread,
      id: String(index),
      path: index === 0 ? null : `file-${index}.ts`,
      line: index === 0 ? null : 4,
      canReply: index !== 0,
      canResolve: index !== 0,
      comments: [{ ...thread.comments[0]!, id: `comment-${index}` }],
    })),
  });
  expect(renderer.root.findAllByType("article")).toHaveLength(10);
  expect(
    renderer.root.findAllByType("span").some((node) => text(node) === "General discussion"),
  ).toBe(true);
  expect(
    renderer.root.findAllByType("button").filter((node) => text(node) === "Resolve"),
  ).toHaveLength(9);
  expect(
    renderer.root.findAllByType("button").filter((node) => text(node) === "Reply…"),
  ).toHaveLength(9);
  act(() => button("Show 2 more threads (2 remaining)").props.onClick());
  expect(renderer.root.findAllByType("article")).toHaveLength(12);
});

it("offers reopening resolved threads and disables writes during other PR actions", async () => {
  render({ ...detail, reviewThreads: [{ ...thread, isResolved: true }] });
  filter("resolved");
  commands.resolve.mockResolvedValueOnce({ _tag: "Success" });
  await act(async () => button("Reopen").props.onClick());
  expect(commands.resolve).toHaveBeenCalledWith({
    environmentId,
    input: { ...reference, threadId: thread.id, resolved: false },
  });
  act(() => renderer.unmount());
  render(detail, true);
  expect(button("Reply…").props.disabled).toBe(true);
  expect(button("Edit comment").props.disabled).toBe(true);
  expect(button("Resolve").props.disabled).toBe(true);
});

it("retries a failed comment page without losing loaded comments", async () => {
  render({
    ...detail,
    reviewThreads: [{ ...thread, nextCommentsCursor: "next", commentCount: 2 }],
  });
  commands.load.mockResolvedValueOnce({ _tag: "Failure" });
  await act(async () => button("Load more comments").props.onClick());
  expect(renderer.root.findAllByType("article")).toHaveLength(1);
  expect(text(renderer.root.findByProps({ role: "alert" }))).toContain("Try again");
  commands.load.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      comments: [{ ...thread.comments[0], id: "second", body: "Later comment" }],
      nextCursor: null,
    },
  });
  await act(async () => button("Load more comments").props.onClick());
  expect(renderer.root.findAllByType("article")).toHaveLength(2);
  expect(button("Load more comments")).toBeUndefined();
});

it("keeps a timeline edit when collapsed and sends its thread ID to the host", async () => {
  const value: PullRequestDetailView = {
    ...detail,
    comments: [
      { ...thread.comments[0]!, kind: "review-comment", path: thread.path, reviewState: null },
    ],
  };
  act(() => {
    renderer = create(
      <PullRequestTimelineTab
        detail={value}
        environmentId={environmentId}
        reference={reference}
        order="newest"
        onOpenCommit={() => {}}
        onRefresh={commands.refresh}
      />,
    );
  });
  const toggle = () => {
    const trigger = renderer.root
      .findAllByType("button")
      .find((node) => typeof node.props["aria-expanded"] === "boolean")!;
    act(() =>
      trigger.props.onClick({ nativeEvent: {}, preventDefault() {}, stopPropagation() {} }),
    );
  };
  toggle();
  act(() => button("Edit comment").props.onClick());
  write("Timeline edit");
  toggle();
  toggle();
  expect(renderer.root.findByType("textarea").props.value).toBe("Timeline edit");
  commands.edit.mockResolvedValueOnce({ _tag: "Success" });
  await act(async () => button("Save").props.onClick());
  expect(commands.edit).toHaveBeenCalledWith({
    environmentId,
    input: {
      ...reference,
      commentId: "comment-one",
      kind: "review-comment",
      body: "Timeline edit",
      threadId: "thread-one",
    },
  });
});

it("blocks review submission while a queued comment is edited and releases the block on close", () => {
  const comment = {
    id: "queued",
    body: "Queued body",
    path: "file.ts",
    position: { kind: "added", newLine: 1 },
  } as const;
  const store = usePullRequestReviewStore.getState();
  store.addComment("pending-key", comment);
  act(() => {
    renderer = create(
      <PendingReviewCommentCard
        comment={comment}
        reviewKey="pending-key"
        environmentId={environmentId}
        workspaceRoot="/workspace"
        pending={false}
        onRemove={() => store.removeComment("pending-key", comment.id)}
        onEdit={(body) => store.updateComment("pending-key", comment.id, body)}
      />,
    );
  });
  act(() => button("Edit").props.onClick());
  write("Still editing");
  expect(usePullRequestReviewStore.getState().editingComments["pending-key"]).toEqual(["queued"]);
  expect(usePullRequestReviewStore.getState().drafts["pending-key"]?.[0]?.body).toBe("Queued body");
  act(() => button("Save").props.onClick());
  expect(usePullRequestReviewStore.getState().editingComments["pending-key"]).toBeUndefined();
  expect(usePullRequestReviewStore.getState().drafts["pending-key"]?.[0]?.body).toBe(
    "Still editing",
  );
  act(() => button("Edit").props.onClick());
  act(() => button("Cancel").props.onClick());
  expect(usePullRequestReviewStore.getState().editingComments["pending-key"]).toBeUndefined();
  act(() => button("Edit").props.onClick());
  act(() => renderer.unmount());
  expect(usePullRequestReviewStore.getState().editingComments["pending-key"]).toBeUndefined();
});
