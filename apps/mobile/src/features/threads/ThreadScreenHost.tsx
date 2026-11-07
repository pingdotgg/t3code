import {
  createContext,
  memo,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { View } from "react-native";

import { ScreenContent } from "../../components/ui/ScreenContent";
import { ThreadDetailScreen, type ThreadDetailScreenProps } from "./ThreadDetailScreen";

type ThreadScreenSnapshot = {
  readonly bodyProps: ThreadDetailScreenProps | null;
  readonly header: ReactNode;
  readonly fallback: ReactNode | null;
};

type BindingPrevious = {
  header: ThreadDetailScreenProps["header"];
  headerKey: readonly unknown[] | null;
  body: readonly unknown[];
  bodyProps: ThreadDetailScreenProps;
};

type FallbackPrevious = {
  fallback: ReactNode;
  header: ReactNode | undefined;
  headerKey: readonly unknown[] | null;
};

function createThreadScreenStore() {
  let snapshot: ThreadScreenSnapshot | null = null;
  let bindingPrevious: BindingPrevious | null = null;
  let fallbackPrevious: FallbackPrevious | null = null;
  let pendingNotify = false;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // Binding renders before the outlet under the host; a silent write lets the
    // outlet read content in the same pass without scheduling a second commit.
    publishBinding(
      props: ThreadDetailScreenProps,
      body: readonly unknown[],
      headerKey: readonly unknown[] | null,
    ) {
      const previous = bindingPrevious;
      const priorHeader = previous?.header ?? fallbackPrevious?.header;
      const priorHeaderKey = previous?.headerKey ?? fallbackPrevious?.headerKey ?? null;
      const fromFallback = previous === null && fallbackPrevious !== null;
      const bodyChanged = previous === null || !fingerprintsEqual(previous.body, body);
      const headerChanged =
        priorHeaderKey === null || headerKey === null
          ? previous === null
            ? fallbackPrevious === null || priorHeader !== props.header
            : previous.header !== props.header
          : !fingerprintsEqual(priorHeaderKey, headerKey);
      if (!bodyChanged && !headerChanged && previous !== null) return;
      // Keep the open-shell header when a later live binding republishes the same chrome key.
      // The first binding after a fallback must still take the live header (real handlers).
      const header =
        headerChanged || priorHeader === undefined || fromFallback
          ? props.header
          : (priorHeader ?? props.header);
      fallbackPrevious = null;
      const bodyProps = bodyChanged || previous === null ? props : previous.bodyProps;
      bindingPrevious = { header, headerKey, body, bodyProps };
      snapshot = {
        bodyProps,
        header: header ?? null,
        fallback: null,
      };
      pendingNotify = true;
    },
    publishFallback(
      fallback: ReactNode,
      header: ReactNode | undefined,
      headerKey: readonly unknown[] | null,
    ) {
      const previous = fallbackPrevious;
      if (
        previous &&
        previous.fallback === fallback &&
        previous.header === header &&
        ((previous.headerKey === null && headerKey === null) ||
          (previous.headerKey !== null &&
            headerKey !== null &&
            fingerprintsEqual(previous.headerKey, headerKey)))
      ) {
        return;
      }
      bindingPrevious = null;
      fallbackPrevious = { fallback, header, headerKey };
      snapshot = { bodyProps: null, header: header ?? null, fallback };
      pendingNotify = true;
    },
    flushNotify() {
      if (!pendingNotify) return;
      pendingNotify = false;
      for (const listener of listeners) listener();
    },
  };
}
const ThreadScreenContext = createContext<ReturnType<typeof createThreadScreenStore> | null>(null);

const MemoThreadDetailScreen = memo(function MemoThreadDetailScreen(
  props: ThreadDetailScreenProps,
) {
  return <ThreadDetailScreen {...props} />;
});

function ThreadScreenOutlet() {
  const store = useContext(ThreadScreenContext)!;
  const content = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (content === null) return null;
  const body = content.bodyProps ? (
    <MemoThreadDetailScreen {...content.bodyProps} />
  ) : (
    content.fallback
  );
  return (
    <>
      {content.header}
      <ScreenContent surface="canvas">{body}</ScreenContent>
    </>
  );
}

/**
 * Body remount fingerprint. Callbacks and header are ignored; `selectedThread` is
 * compared by fields because route content may wrap the shell each render.
 */
function threadDetailBodyFingerprint(props: ThreadDetailScreenProps): readonly unknown[] {
  const thread = props.selectedThread;
  return [
    thread.id,
    thread.title,
    thread.source,
    thread.modelSelection,
    thread.runtimeMode,
    thread.interactionMode,
    thread.goal,
    thread.snoozedUntil,
    thread.settledOverride,
    thread.lastVisitedAt,
    thread.latestUserMessageAt,
    thread.latestRun,
    thread.runtime,
    thread.limitRecovery,
    thread.pendingBackgroundTasks,
    thread.lineage.parentThreadId,
    props.selectedThreadDetailRef,
    props.contentPresentation,
    props.activityRun,
    props.activeWorkStartedAt,
    props.runlessWorkActive,
    props.providerSubagentStatus,
    props.extensionStatuses,
    props.isCompacting,
    props.creationState,
    props.activePendingApproval,
    props.activePendingApprovals,
    props.respondingApprovalId,
    props.activePendingUserInput,
    props.activePendingUserInputDrafts,
    props.activePendingUserInputAnswers,
    props.respondingUserInputId,
    props.connectionStateLabel,
    props.threadSyncStatus,
    props.historyControls,
    props.activeThreadBusy,
    props.canStopThread,
    props.queuedRunEdit,
    props.composerDraftKey,
    props.followUpBehavior,
    props.canSteerActiveTurn,
    props.isSavingQueuedEdit,
    props.environmentId,
    props.projectWorkspaceRoot,
    props.threadCwd,
    props.selectedThreadQueueCount,
    props.queuedMessages,
    props.dispatchingMessageId,
    props.serverConfig,
    props.layoutVariant,
    props.usesAutomaticContentInsets,
    props.canOperateThread,
    props.screenTone,
    props.connectionError,
    props.environmentLabel,
    props.feedbackSubmissions,
    props.pendingHandoff,
    props.worktreeSetup,
    props.setupWorkingStartedAt,
    props.draftMode,
    props.canSwitchThreadProvider,
    props.offersSideChat,
    props.showContent,
    props.selectedThreadFeed,
  ];
}

function fingerprintsEqual(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}

// Controllers can change from draft to live without replacing the native screen,
// the keyboard host, or the editor. Publish during Binding render so the outlet
// can paint detail in the same host pass.
export function ThreadScreenHost({ children }: { readonly children: ReactNode }) {
  const [store] = useState(createThreadScreenStore);
  return (
    <ThreadScreenContext.Provider value={store}>
      {children}
      <View className="flex-1 bg-screen android:bg-header">
        <ThreadScreenOutlet />
      </View>
    </ThreadScreenContext.Provider>
  );
}

export function ThreadScreenBinding({
  headerKey,
  ...props
}: ThreadDetailScreenProps & {
  /** When set, header updates only when this fingerprint changes — not on a new React element. */
  readonly headerKey?: readonly unknown[];
}) {
  const store = useContext(ThreadScreenContext)!;
  store.publishBinding(props, threadDetailBodyFingerprint(props), headerKey ?? null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- wakes the outlet after Binding wrote the store during render
  useLayoutEffect(() => {
    store.flushNotify();
  });
  return null;
}

export function ThreadScreenFallback({
  children,
  header,
  headerKey,
}: {
  readonly children: ReactNode;
  readonly header?: ReactNode;
  /** Same fingerprint shape as ThreadScreenBinding so shell→live can keep the AppBar. */
  readonly headerKey?: readonly unknown[];
}) {
  const store = useContext(ThreadScreenContext)!;
  store.publishFallback(children, header, headerKey ?? null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- wakes the outlet after Fallback wrote the store during render
  useLayoutEffect(() => {
    store.flushNotify();
  });
  return null;
}
