import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  viewer: "alice",
  update: vi.fn(),
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
  Alert: { alert: vi.fn() },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/native", () => ({
  useFocusEffect: () => {},
  useNavigation: () => ({ goBack: vi.fn() }),
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
vi.mock("./usePendingReviewCommentActions", () => ({ usePendingReviewCommentActions: () => ({}) }));
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
    ready: true,
    busy: false,
    error: null,
    update: mocks.update,
    flush: async () => true,
    comments: mocks.viewer === "alice" ? [{ id: "draft", body: "Alice's private feedback" }] : [],
  }),
}));
import { PullRequestInlineCommentScreen } from "./PullRequestInlineCommentScreen";

it("blocks an open editor's text from being saved by a different account", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.viewer = "alice";
  mocks.update.mockClear();
  mocks.save.mockClear();
  mocks.buttons.clear();
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
  await act(async () => save.onPress());
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(save.disabled).toBe(true);
});
