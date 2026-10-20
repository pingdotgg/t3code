import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import type { VcsStatusLocalResult } from "@t3tools/contracts";
import { GIT_VCS_TERMINOLOGY, JJ_VCS_TERMINOLOGY } from "@t3tools/shared/vcs";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { presentThreadShell } from "../../../../packages/client-runtime/src/state/models";
import { v2ThreadShell } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";

const state = vi.hoisted(() => ({
  status: vi.fn(),
  threadCommit: vi.fn(),
  reviewCommit: vi.fn(),
  reviewSections: vi.fn(() => ({
    error: null,
    reviewSections: [],
    selectedSection: null,
    refreshSelectedSection: async () => {},
    selectSection: () => {},
    isSelectedSectionPending: false,
    diffPreviewRevision: 0,
  })),
}));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
// Mock factories run before static imports initialize, so load their React/atom dependencies here.
vi.mock("./atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("@t3tools/client-runtime/state/vcs", () => ({
  createVcsEnvironmentAtoms: () => ({ status: state.status }),
  createVcsActionManager: () => ({}),
}));

// Keep the screens and query hooks real; replace only unrelated state and native surfaces.
vi.mock("react-native", () => {
  const Surface = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View: Surface,
    ScrollView: Surface,
    FlatList: () => null,
    Pressable: Surface,
    RefreshControl: () => null,
    Platform: { OS: "ios", select: (values: { ios?: unknown }) => values.ios },
    StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
    Keyboard: { dismiss: () => {} },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
  };
});
vi.mock("react-native-screens", () => ({
  Screen: () => null,
  ScreenStack: () => null,
  ScreenStackHeaderConfig: () => null,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: () => {}, canGoBack: () => false }),
}));
vi.mock("@react-navigation/elements", async () => {
  const { createContext } = await import("react");
  return { HeaderHeightContext: createContext(44) };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => {} }));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { dismiss: async () => {} },
  KeyboardStickyView: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useKeyboardState: (select: (value: { isVisible: boolean; height: number }) => unknown) =>
    select({ isVisible: false, height: 0 }),
}));
vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  function useSharedValue<T>(value: T) {
    return useRef({
      value,
      set(next: T) {
        this.value = next;
      },
    }).current;
  }
  function useDerivedValue<T>(derive: () => T) {
    return useSharedValue(derive());
  }
  return {
    default: { View: ({ children }: { children?: ReactNode }) => <>{children}</> },
    Easing: { out: () => {}, cubic: () => {} },
    FadeInDown: { duration: () => undefined },
    FadeOut: { duration: () => undefined },
    ReduceMotion: { System: "system" },
    useReducedMotion: () => false,
    useSharedValue,
    useDerivedValue,
    useAnimatedStyle: (derive: () => unknown) => derive(),
    useAnimatedReaction: () => {},
    withTiming: (value: number) => value,
  };
});
vi.mock("@legendapp/list/keyboard", async () => {
  const { useRef } = await import("react");
  return {
    useKeyboardChatComposerInset: () => ({
      contentInsetEndAdjustment: { value: 0 },
      onComposerLayout: () => {},
    }),
    // The native hook retains its freeze SharedValue across renders. A fresh
    // object would retrigger ThreadDetailScreen's unrelated thread-reset effect.
    useKeyboardScrollToEnd: () =>
      useRef({ freeze: { set: () => {} }, scrollMessageToEnd: async () => {} }).current,
  };
});
vi.mock("../components/ui/Dialog", () => ({ alert: () => {} }));
vi.mock("../components/ui/AppText", () => ({
  AppText: ({
    children,
    accessibilityRole,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
  }) => <span role={accessibilityRole}>{children}</span>,
}));
vi.mock("../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../components/ui/AndroidScreenHeader", () => ({ AndroidScreenHeader: () => null }));
vi.mock("../components/RenderErrorBoundary", () => ({
  RenderErrorBoundary: ({ children }: { children?: ReactNode }) => <>{children}</>,
  RenderFailureView: () => null,
}));
vi.mock("../native/StackHeader", () => ({ nativeHeaderScrollEdgeEffects: () => ({}) }));
vi.mock("../native/NativeLayoutObserver", () => ({ NativeLayoutObserver: () => null }));
vi.mock("../native/NativeWorkspaceColumns", () => ({
  useNativeWorkspaceColumnsSupported: () => false,
}));
vi.mock("../native/native-layout-metrics", () => ({ useNativeColumnLayoutMetrics: () => null }));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { retryNow: {} } }));
vi.mock("./entities", async () => {
  const { useLayoutEffect } = await import("react");
  return {
    useChildThreadInputs: () => [],
    useThreadShell: () => null,
    useThreadReportedModelSelection: () => {
      useLayoutEffect(() => {
        state.threadCommit();
      });
      return null;
    },
  };
});
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: { environmentId: "environment" } }),
}));
vi.mock("./use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: "/repo" }),
}));
vi.mock("./device", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const atom = Atom.make(AsyncResult.success(null));
  return { deviceEnvironment: { state: () => atom } };
});
vi.mock("../features/devices/threadDevicePreviews", () => ({ threadDevicePreviews: () => [] }));
vi.mock("./preview", () => ({ useThreadServerBrowserTabs: () => ({ tabs: [], loaded: true }) }));
vi.mock("./use-composer-drafts", () => ({ getComposerDraftSnapshot: () => ({ text: "" }) }));
vi.mock("./edit-pending-thread-message", () => ({ editPendingThreadMessage: async () => false }));
vi.mock("./thread-composer-error", async () => {
  const { Atom } = await import("effect/reactivity");
  return { threadComposerErrorsAtom: Atom.make({}), clearThreadComposerError: () => {} };
});
vi.mock("./threads", () => ({ threadEnvironment: { visit: {} } }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => async () => {} }));
vi.mock("./presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: "connected" } },
  }),
}));
vi.mock("./use-thread-composer-state", () => ({
  useThreadDraftForThread: () => ({ draftMessage: "" }),
}));
vi.mock("../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({ "--color-icon": "black" }) }));
vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("../features/settings/appearance/useAppearanceCodeSurface", async () => {
  const { useLayoutEffect } = await import("react");
  return {
    useAppearanceCodeSurface: () => {
      useLayoutEffect(() => {
        state.reviewCommit();
      });
      return { nativeReviewDiffStyle: { rowHeight: 20 } };
    },
  };
});
vi.mock("../features/layout/workspace-content-width", () => ({
  useWorkspaceContentWidth: () => null,
}));
vi.mock("../features/layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspacePaneRole: () => {},
  useAdaptiveWorkspaceLayout: () => ({
    panes: { supportsAuxiliaryPane: false, auxiliaryPaneVisible: false },
    showAuxiliaryPane: () => {},
    toggleAuxiliaryPane: () => {},
  }),
  useRegisterWorkspaceInspector: () => {},
}));
vi.mock("../features/voice-input/VoiceInputProvider", () => ({
  useGlobalVoiceInput: () => ({ session: {} }),
}));
vi.mock("../features/browser/ThreadBrowserFloat", () => ({ ThreadBrowserFloat: () => null }));
vi.mock("../features/connection/EnvironmentConnectionNotice", () => ({
  EnvironmentConnectionNotice: () => null,
}));
vi.mock("../features/threads/UsageLimitRecoveryCard", () => ({
  UsageLimitRecoveryCard: () => null,
}));
vi.mock("../features/threads/PendingApprovalCard", () => ({ PendingApprovalCard: () => null }));
vi.mock("../features/threads/ComposerErrorNotice", () => ({ ComposerErrorNotice: () => null }));
vi.mock("../features/threads/ComposerFeedback", () => ({ ComposerFeedback: () => null }));
vi.mock("../features/threads/ComposerUsageLimits", () => ({ ComposerUsageLimits: () => null }));
vi.mock("../features/threads/PendingUserInputCard", () => ({ PendingUserInputCard: () => null }));
vi.mock("../features/threads/ProviderSubagentBar", () => ({ ProviderSubagentBar: () => null }));
vi.mock("../features/threads/ThreadCreationFailedCard", () => ({
  ThreadCreationFailedCard: () => null,
}));
vi.mock("../features/threads/floating-working-control", () => ({
  FLOATING_WORKING_CONTROL_COVERAGE: 0,
  FloatingWorkingControl: () => null,
}));
vi.mock("../features/threads/ThreadComposer", () => ({
  COMPOSER_COLLAPSED_CHROME: 50,
  COMPOSER_EXPANDED_CHROME: 100,
  COMPOSER_LAYOUT_TRANSITION: undefined,
  COMPOSER_TRANSITION_DURATION_MS: 0,
  ThreadComposer: () => null,
}));
vi.mock("../features/threads/ComposerPopoverHost", () => ({
  ComposerPopoverHost: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("../features/threads/ThreadFeed", () => ({ ThreadFeed: () => null }));
vi.mock("../features/threads/ThreadAgentsSheet", () => ({ useThreadTurnSubagents: () => null }));
vi.mock("../features/threads/ComposerQueuedEdit", () => ({ ComposerQueuedEditBanner: () => null }));
vi.mock("../features/threads/ThreadQueueControl", () => ({ useThreadQueuedCount: () => 0 }));
vi.mock("../features/review/useReviewHeaderPresentation", () => ({
  useReviewHeaderPresentation: () => ({ title: "Review changes", gitMenu: null }),
}));
vi.mock("../features/review/reviewState", () => ({
  useReviewCacheForThread: () => ({
    threadKey: "thread",
    expandedFileIdsBySection: {},
    viewedFileIdsBySection: {},
  }),
}));
vi.mock("../features/diffs/nativeReviewDiffSurface", () => ({
  resolveNativeReviewDiffView: () => null,
  isNativeReviewDiffDrawEvent: () => false,
}));
vi.mock("../features/review/nativeReviewDiffAdapter", () => ({
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH: 400,
}));
vi.mock("../features/review/useReviewDiffData", () => ({
  useReviewDiffData: () => ({
    headerDiffSummary: { additions: "", deletions: "" },
    nativeReviewDiffData: { files: [] },
    parsedDiff: { kind: "empty" },
    pendingReviewCommentCount: 0,
    loadVisibleFile: () => {},
    isPending: false,
  }),
}));
vi.mock("../features/review/useReviewDiffPrewarming", () => ({
  useReviewDiffPrewarming: () => {},
}));
vi.mock("../features/review/reviewFileVisibility", () => ({
  useReviewFileVisibility: () => ({
    collapsedFileIds: [],
    viewedFileIds: [],
    toggleExpandedFile: () => {},
    toggleViewedFile: () => {},
  }),
}));
vi.mock("../features/review/useReviewSections", () => ({
  useReviewSections: state.reviewSections,
}));
vi.mock("../features/review/useNativeReviewDiffBridge", () => ({
  useNativeReviewDiffBridge: () => ({}),
}));
vi.mock("../features/review/useReviewCommentSelectionController", () => ({
  useReviewCommentSelectionController: () => ({
    selectedRowIds: [],
    selectionAction: null,
    clearSelection: () => {},
  }),
}));
vi.mock("../features/showcase/showcaseRenderSignal", () => ({
  reportShowcaseSceneRendered: () => {},
}));

import { ThreadDetailScreen } from "../features/threads/ThreadDetailScreen";
import type { ThreadDetailScreenProps } from "../features/threads/ThreadDetailScreen";
import { ReviewSheet } from "../features/review/ReviewSheet";
import { useVcsActionSupport, useVcsTerminology, vcsEnvironment } from "./vcs";
import { useEnvironmentQuery } from "./query";

const environmentId = EnvironmentId.make("environment");
const selectedThread = presentThreadShell(environmentId, v2ThreadShell);
const noop = () => {};
const asyncNoop = async () => {};
const threadProps: ThreadDetailScreenProps = {
  canOperateThread: true,
  selectedThread,
  selectedThreadDetailRef: { environmentId, threadId: selectedThread.id },
  contentPresentation: { kind: "ready" },
  screenTone: { label: "Idle", pillClassName: "", textClassName: "" },
  connectionError: null,
  environmentLabel: "Environment",
  feedbackSubmissions: [],
  onDismissFeedback: noop,
  selectedThreadFeed: [],
  activityRun: null,
  activeWorkStartedAt: null,
  isCompacting: false,
  creationState: null,
  activePendingApproval: null,
  respondingApprovalId: null,
  activePendingUserInput: null,
  activePendingUserInputDrafts: {},
  activePendingUserInputAnswers: null,
  respondingUserInputId: null,
  connectionStateLabel: "connected",
  activeThreadBusy: false,
  canStopThread: false,
  queuedRunEdit: null,
  composerDraftKey: null,
  followUpBehavior: "queue",
  canSteerActiveTurn: false,
  isSavingQueuedEdit: false,
  onCancelQueuedRunEdit: noop,
  onRemoveQueuedEditAttachment: noop,
  environmentId,
  projectWorkspaceRoot: "/repo",
  threadCwd: "/repo",
  selectedThreadQueueCount: 0,
  queuedMessages: [],
  dispatchingMessageId: null,
  serverConfig: null,
  onOpenConnectionEditor: noop,
  onChangeDraftMessage: noop,
  onPickDraftMedia: asyncNoop,
  onPickDraftFiles: asyncNoop,
  onNativePasteImages: asyncNoop,
  onNativePasteText: asyncNoop,
  onRemoveDraftImage: noop,
  onStopThread: noop,
  onResumeQueue: null,
  onSendMessage: async () => null,
  onReconnectEnvironment: noop,
  canSwitchThreadProvider: false,
  onUpdateThreadModelSelection: noop,
  onUpdateThreadRuntimeMode: noop,
  onUpdateThreadInteractionMode: noop,
  onRespondToApproval: asyncNoop,
  onSelectUserInputOption: noop,
  onChangeUserInputCustomAnswer: noop,
  onSubmitUserInput: asyncNoop,
  onDismissUserInput: asyncNoop,
};
const gitStatus: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

it("does not rerender passive Git hooks on ordinary or waiting local status events", async () => {
  const registry = AtomRegistry.make();
  const statusAtom = Atom.make<AsyncResult.AsyncResult<VcsStatusLocalResult>>(
    AsyncResult.success(gitStatus),
  );
  state.status.mockReset().mockReturnValue(statusAtom);
  let renders = 0;
  let terminology = GIT_VCS_TERMINOLOGY;
  let unsupportedReason: string | null = null;
  function Probe() {
    renders += 1;
    terminology = useVcsTerminology(environmentId, "/repo");
    unsupportedReason = useVcsActionSupport(environmentId, "/repo").unsupportedReason;
    return null;
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  try {
    await act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <Probe />
        </RegistryContext.Provider>,
      ),
    );
    expect(terminology).toBe(GIT_VCS_TERMINOLOGY);
    expect(unsupportedReason).toBeNull();
    expect(state.status).toHaveBeenCalledTimes(2);
    for (const [target] of state.status.mock.calls) {
      expect(target).toEqual({ environmentId, input: { cwd: "/repo", includeRemote: false } });
    }
    const initialRenders = renders;
    await act(() =>
      registry.set(statusAtom, AsyncResult.success({ ...gitStatus, hasWorkingTreeChanges: true })),
    );
    expect(renders - initialRenders).toBe(0);
    await act(() => registry.set(statusAtom, AsyncResult.waiting(AsyncResult.success(gitStatus))));
    expect(renders - initialRenders).toBe(0);
    await act(() =>
      registry.set(statusAtom, AsyncResult.success({ ...gitStatus, vcs: { kind: "jj" } })),
    );
    expect(renders - initialRenders).toBe(1);
    expect(terminology).toBe(JJ_VCS_TERMINOLOGY);
    await act(() =>
      registry.set(
        statusAtom,
        AsyncResult.success({
          ...gitStatus,
          vcs: { kind: "jj", unsupportedReason: "Unsupported workspace" },
        }),
      ),
    );
    expect(renders - initialRenders).toBe(2);
    expect(unsupportedReason).toBe("Unsupported workspace");
    await act(() => registry.set(statusAtom, AsyncResult.success(gitStatus)));
    expect(renders - initialRenders).toBe(3);
    expect(terminology).toBe(GIT_VCS_TERMINOLOGY);
    expect(unsupportedReason).toBeNull();
  } finally {
    await act(() => root.unmount());
    registry.dispose();
    vi.unstubAllGlobals();
  }
});

it.each(["ThreadDetailScreen", "ReviewSheet"] as const)(
  "%s shares full status with its sibling without rendering on ordinary or waiting events",
  async (screen) => {
    const registry = AtomRegistry.make();
    const target = { environmentId, input: { cwd: "/repo" } };
    const statusAtom = Atom.make<AsyncResult.AsyncResult<VcsStatusLocalResult>>(
      AsyncResult.success(gitStatus),
    );
    const atoms = new Map([[JSON.stringify(target), statusAtom]]);
    state.status.mockReset().mockImplementation((input) => {
      const key = JSON.stringify(input);
      let atom = atoms.get(key);
      if (!atom) {
        atom = Atom.make<AsyncResult.AsyncResult<VcsStatusLocalResult>>(
          AsyncResult.success(gitStatus),
        );
        atoms.set(key, atom);
      }
      return atom;
    });
    state.reviewSections.mockClear();
    // These layout effects belong to the actual screen's fiber: count its
    // commits, excluding speculative calls and descendant-only updates.
    const renders = screen === "ThreadDetailScreen" ? state.threadCommit : state.reviewCommit;
    renders.mockClear();
    let siblingRenders = 0;
    function FullStatusSibling() {
      siblingRenders += 1;
      useEnvironmentQuery(vcsEnvironment.status(target));
      return null;
    }
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          <RegistryContext.Provider value={registry}>
            {screen === "ThreadDetailScreen" ? (
              <ThreadDetailScreen {...threadProps} />
            ) : (
              <ReviewSheet route={{ params: { environmentId, threadId: selectedThread.id } }} />
            )}
            <FullStatusSibling />
          </RegistryContext.Provider>,
        ),
      );
      expect(renders).toHaveBeenCalled();
      expect(siblingRenders).toBeGreaterThan(0);
      expect(atoms.size).toBe(1);
      for (const [input] of state.status.mock.calls) expect(input).toEqual(target);

      const publish = async (
        result: AsyncResult.AsyncResult<VcsStatusLocalResult>,
        expectedRenders: number,
      ) => {
        const before = renders.mock.calls.length;
        const siblingBefore = siblingRenders;
        await act(() => registry.set(statusAtom, result));
        expect(renders.mock.calls.length - before).toBe(expectedRenders);
        expect(siblingRenders - siblingBefore).toBe(1);
        expect(atoms.size).toBe(1);
      };
      const dirtyGitStatus = { ...gitStatus, hasWorkingTreeChanges: true };
      await publish(AsyncResult.success(dirtyGitStatus), 0);
      await publish(AsyncResult.waiting(AsyncResult.success(dirtyGitStatus)), 0);
      const jjStatus: VcsStatusLocalResult = { ...gitStatus, vcs: { kind: "jj" } };
      await publish(AsyncResult.success(jjStatus), 1);
      if (screen === "ReviewSheet") {
        expect(state.reviewSections).toHaveBeenLastCalledWith(
          expect.objectContaining({ vcsKind: "jj", enabled: true }),
        );
      }
      await publish(AsyncResult.success({ ...jjStatus, hasWorkingTreeChanges: true }), 0);
      await publish(AsyncResult.waiting(AsyncResult.success(jjStatus)), 0);
      const unsupportedStatus: VcsStatusLocalResult = {
        ...jjStatus,
        vcs: { kind: "jj", unsupportedReason: "Unsupported workspace" },
      };
      await publish(AsyncResult.success(unsupportedStatus), 1);
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("Unsupported workspace");
      if (screen === "ReviewSheet") {
        expect(state.reviewSections).toHaveBeenLastCalledWith(
          expect.objectContaining({ vcsKind: "jj", enabled: false }),
        );
      }
      await publish(AsyncResult.waiting(AsyncResult.success(unsupportedStatus)), 0);
      await publish(AsyncResult.success(jjStatus), 1);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      await publish(AsyncResult.success(gitStatus), 1);
      if (screen === "ReviewSheet") {
        expect(state.reviewSections).toHaveBeenLastCalledWith(
          expect.objectContaining({ vcsKind: null, enabled: true }),
        );
      }
      if (screen === "ThreadDetailScreen") {
        const notice = "Jujutsu could not run: Config error: invalid configuration";
        await publish(AsyncResult.success({ ...gitStatus, vcs: { kind: "git", notice } }), 1);
        expect(container.textContent).toContain(notice);
        await publish(AsyncResult.success(gitStatus), 1);
        expect(container.textContent).not.toContain(notice);
      }
    } finally {
      await act(() => root.unmount());
      registry.dispose();
      vi.unstubAllGlobals();
    }
  },
);
