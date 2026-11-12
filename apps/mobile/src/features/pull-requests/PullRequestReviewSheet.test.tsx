import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  activityLoaded: false,
  activityError: null as string | null,
  buttons: new Map<string, { disabled: boolean; onPress: () => void }>(),
  review: vi.fn(),
  refreshActivity: vi.fn(),
  goBack: vi.fn(),
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: { replace: () => null },
  useNavigation: () => ({ goBack: mocks.goBack }),
  useFocusEffect: () => {},
}));
vi.mock("@effect/atom-react", () => ({ useAtomRefresh: () => () => {} }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled: boolean; onPress: () => void }) => {
    mocks.buttons.set(props.label, props);
    return null;
  },
}));
vi.mock("../../components/ui/Menu", () => ({ Menu: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./PullRequestSheetContent", () => ({
  PullRequestSheetContent: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
vi.mock("./PullRequestCommentForm", () => ({ PullRequestCommentForm: () => null }));
vi.mock("./PullRequestPendingComment", () => ({
  PullRequestPendingBadge: () => null,
  PullRequestPendingCommentActions: () => null,
}));
vi.mock("./pullRequestDiffComments", () => ({ reviewPositionLabel: () => "Line 1" }));
vi.mock("./usePullRequestPermissions", () => ({
  usePullRequestPermissions: () => ({ canInlineComment: true, verdicts: ["comment"] }),
}));
vi.mock("./usePullRequestDiff", () => ({
  pullRequestTarget: (params: object) => ({ environmentId: "env", input: params }),
}));
vi.mock("../../state/pull-requests", () => ({
  composerPullRequests: {
    detail: () => null,
    activity: () => null,
    submitReview: null,
    comment: null,
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { headSha: "head", provider: "github" },
    isPending: false,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.review }));
vi.mock("./usePullRequestReviewDraft", () => ({
  setReviewDraftBusy: () => true,
  retireReviewDraftComments: () => {},
  usePullRequestReviewDraft: (params: object) => ({
    scope: { ...params, viewer: "alice" },
    draft: { summary: "Summary", comment: "", comments: [] },
    comments: [],
    outdatedComments: [],
    ready: true,
    isReady: () => true,
    busy: false,
    error: null,
    activityLoaded: mocks.activityLoaded,
    activityError: mocks.activityError,
    pendingReviewId: mocks.activityLoaded ? "private-review" : undefined,
    refreshActivity: mocks.refreshActivity,
    update: () => {},
    complete: () => {},
    flush: async () => true,
  }),
}));

import { PullRequestReviewSheet } from "./PullRequestReviewSheet";

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.activityLoaded = false;
  mocks.activityError = null;
  mocks.buttons.clear();
  mocks.review.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  mocks.refreshActivity.mockClear();
  mocks.goBack.mockClear();
  const root = createRoot(document.createElement("div"));
  const route = {
    params: {
      environmentId: "env",
      projectId: "project",
      repository: "owner/repo",
      number: 1,
      mode: "review" as const,
    },
  };
  return {
    render() {
      act(() => root.render(<PullRequestReviewSheet route={route} />));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("waits for a successful activity read and submits the discovered pending review after retry", async () => {
  using screen = setup();
  screen.render();
  expect(mocks.buttons.get("Submit review")!.disabled).toBe(true);
  await act(async () => mocks.buttons.get("Submit review")!.onPress());
  expect(mocks.review).not.toHaveBeenCalled();
  mocks.activityError = "Connection lost";
  screen.render();
  expect(mocks.buttons.get("Submit review")!.disabled).toBe(true);
  act(() => mocks.buttons.get("Retry loading pending review")!.onPress());
  expect(mocks.refreshActivity).toHaveBeenCalledTimes(1);
  mocks.activityLoaded = true;
  mocks.activityError = null;
  screen.render();
  expect(mocks.buttons.get("Submit review")!.disabled).toBe(false);
  await act(async () => mocks.buttons.get("Submit review")!.onPress());
  expect(mocks.review).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ pendingReviewId: "private-review" }),
    }),
  );
  expect(mocks.goBack).toHaveBeenCalledTimes(1);
});
