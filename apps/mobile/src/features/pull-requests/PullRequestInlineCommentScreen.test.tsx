import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { PendingReviewComment, ReviewDraft } from "./pullRequestReviewDrafts";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  viewer: "alice",
  ready: true,
  flush: vi.fn().mockResolvedValue(true),
  goBack: vi.fn(),
  alert: vi.fn(),
  update: vi.fn(),
  discard: vi.fn(),
  comments: null as readonly PendingReviewComment[] | null,
  save: vi.fn().mockResolvedValue({ _tag: "Success", value: {} }),
  buttons: new Map<string, { disabled: boolean; onPress: () => void }>(),
  form: null as { value: string; onChangeText: (text: string) => void } | null,
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "generated" }));
vi.mock("./usePullRequestDiff", () => ({
  pullRequestTarget: (params: object) => ({ environmentId: "env", input: params }),
}));
vi.mock("./pullRequestDiffComments", () => ({ reviewPositionLabel: () => "Line 1" }));
vi.mock("react-native", () => ({
  Alert: { alert: mocks.alert },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/native", () => ({
  useFocusEffect: () => {},
  useNavigation: () => ({ goBack: mocks.goBack }),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled: boolean; onPress: () => void }) => {
    mocks.buttons.set(props.label, props);
    return null;
  },
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./PullRequestSheetContent", () => ({
  PullRequestSheetContent: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
vi.mock("./PullRequestCommentForm", () => ({
  PullRequestCommentForm: (props: { value: string; onChangeText: (text: string) => void }) => {
    mocks.form = props;
    return null;
  },
}));
vi.mock("./PullRequestCommentCard", () => ({ PullRequestThreadCard: () => null }));
vi.mock("./PullRequestPendingComment", () => ({
  PullRequestPendingBadge: () => null,
  PullRequestPendingCommentActions: () => null,
}));
vi.mock("./usePendingReviewCommentActions", () => ({
  usePendingReviewCommentActions: () => ({ discard: mocks.discard }),
}));
vi.mock("./usePullRequestThreads", () => ({
  pendingCommentComposerContext: () => null,
  usePullRequestThreads: () => ({ canAddToComposer: false }),
}));
vi.mock("./usePullRequestPermissions", () => ({
  usePullRequestPermissions: () => ({ canInlineComment: true }),
}));
vi.mock("../../state/pull-requests", () => ({
  composerPullRequests: {
    detail: () => null,
    activity: () => null,
    updateComment: null,
    saveDraftComment: null,
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      viewer: mocks.viewer,
      headSha: "head",
      reviewThreads: [],
      capabilities: { review: { draftComment: true } },
    },
    isPending: false,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.save }));
vi.mock("./usePullRequestReviewDraft", () => ({
  setReviewDraftBusy: () => true,
  usePullRequestReviewDraft: (params: object) => ({
    scope: { ...params, viewer: mocks.viewer },
    ready: mocks.ready,
    isReady: () => mocks.ready,
    busy: false,
    error: null,
    update: mocks.update,
    complete: mocks.update,
    flush: mocks.flush,
    comments:
      mocks.comments ??
      (mocks.viewer === "alice" ? [{ id: "draft", body: "Alice's private feedback" }] : []),
  }),
}));
import { PullRequestInlineCommentScreen } from "./PullRequestInlineCommentScreen";

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.viewer = "alice";
  mocks.ready = true;
  mocks.update.mockReset();
  mocks.discard.mockReset();
  mocks.comments = null;
  mocks.save.mockClear();
  mocks.flush.mockReset().mockResolvedValue(true);
  mocks.goBack.mockClear();
  mocks.alert.mockClear();
  mocks.buttons.clear();
  mocks.form = null;
}

it("blocks an open editor's text from being saved by a different account", async () => {
  setup();
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const route = {
    params: {
      environmentId: "env",
      projectId: "project",
      repository: "owner/repo",
      number: 1,
      draftId: "draft",
      path: "a.ts",
      position: { kind: "added" as const, newLine: 1 },
      headSha: "head",
      code: "code",
      body: "Alice's private feedback",
    },
  };
  act(() => root.render(<PullRequestInlineCommentScreen route={route} />));
  act(() => mocks.form!.onChangeText("Alice's unsaved edit"));
  mocks.viewer = "bob";
  act(() => root.render(<PullRequestInlineCommentScreen route={route} />));
  const save = mocks.buttons.get("Add to review")!;
  expect(mocks.form!.value).toBe("");
  await act(async () => save.onPress());
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(save.disabled).toBe(true);
});

it.each([1, 2])("keeps the editor open when draft flush %i fails", async (failedFlush) => {
  setup();
  mocks.flush.mockResolvedValueOnce(failedFlush === 2).mockResolvedValueOnce(false);
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const route = {
    params: {
      environmentId: "env",
      projectId: "project",
      repository: "owner/repo",
      number: 1,
      path: "a.ts",
      position: { kind: "added" as const, newLine: 1 },
      headSha: "head",
      code: "code",
      body: "Feedback",
    },
  };
  act(() => root.render(<PullRequestInlineCommentScreen route={route} />));
  act(() => mocks.form!.onChangeText("Feedback"));
  await act(async () => mocks.buttons.get("Add to review")!.onPress());
  expect(mocks.goBack).not.toHaveBeenCalled();
  expect(mocks.alert).toHaveBeenCalledWith(
    "Could not save the review comment",
    expect.stringContaining("Could not save the draft on this device."),
  );
  expect(mocks.save).toHaveBeenCalledTimes(failedFlush - 1);
});

it("waits for settled ownership before showing or editing text and capturing the editor account", async () => {
  setup();
  mocks.ready = false;
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const route = {
    params: {
      environmentId: "env",
      projectId: "project",
      repository: "owner/repo",
      number: 1,
      path: "a.ts",
      position: { kind: "added" as const, newLine: 1 },
      headSha: "head",
      code: "code",
      body: "Unowned route text",
    },
  };
  act(() => root.render(<PullRequestInlineCommentScreen route={route} />));
  expect(mocks.form!.value).toBe("");
  act(() => mocks.form!.onChangeText("Unowned edit"));
  mocks.viewer = "bob";
  mocks.ready = true;
  act(() => root.render(<PullRequestInlineCommentScreen route={route} />));
  expect(mocks.form!.value).toBe("");
  act(() => mocks.form!.onChangeText("Bob's feedback"));
  await act(async () => mocks.buttons.get("Add to review")!.onPress());
  expect(mocks.save).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        comment: expect.objectContaining({ body: "Bob's feedback" }),
      }),
    }),
  );
});

it("keeps a moved hosted draft locally while identity refreshes and does not start another hosted save", async () => {
  setup();
  mocks.comments = [
    {
      id: "draft",
      path: "a.ts",
      headSha: "old",
      code: "old line",
      body: "Alice's feedback",
      position: { kind: "added", newLine: 1 },
      hostedComment: { reviewId: "review", commentId: "hosted", url: "https://host/comment" },
    },
  ];
  mocks.update.mockImplementation((transform: (draft: ReviewDraft) => ReviewDraft) => {
    mocks.comments = transform({
      summary: "",
      comment: "",
      comments: mocks.comments ?? [],
    }).comments;
  });
  mocks.discard.mockImplementation(async () => {
    mocks.ready = false;
    mocks.comments = [];
    return true;
  });
  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  const route = {
    params: {
      environmentId: "env",
      projectId: "project",
      repository: "owner/repo",
      number: 1,
      draftId: "draft",
      path: "a.ts",
      position: { kind: "added" as const, newLine: 2 },
      headSha: "head",
      code: "new line",
    },
  };
  act(() => root.render(<PullRequestInlineCommentScreen route={route} />));
  await act(async () => mocks.buttons.get("Save")!.onPress());
  expect(mocks.comments).toMatchObject([
    { headSha: "head", position: { kind: "added", newLine: 2 }, body: "Alice's feedback" },
  ]);
  expect(mocks.comments[0]?.hostedComment).toBeUndefined();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.goBack).not.toHaveBeenCalled();
  expect(mocks.alert).toHaveBeenCalledWith(
    "Could not save the review comment",
    expect.stringContaining("save again"),
  );
  mocks.viewer = "bob";
  mocks.ready = true;
  act(() => root.render(<PullRequestInlineCommentScreen route={route} />));
  await act(async () => mocks.buttons.get("Save")!.onPress());
  expect(mocks.save).not.toHaveBeenCalled();
});
