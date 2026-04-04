import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking } from "react-native";

import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  ProjectId,
  type ProviderApprovalDecision,
  type ServerConfig as T3ServerConfig,
  ThreadId,
} from "@t3tools/contracts";
import { deriveActiveWorkStartedAt, formatElapsed } from "@t3tools/shared/orchestrationTiming";
import { parseRemoteAppConnectionUrl } from "@t3tools/shared/remote";

import { connectionTone } from "../features/connection/connectionTone";
import { screenTitle, threadSortValue } from "../features/threads/threadPresentation";
import { newClientId } from "../lib/clientId";
import {
  preflightRemoteConnection,
  resolveRemoteConnection,
  type RemoteConnectionInput,
} from "../lib/connection";
import {
  applyOptimisticUserMessage,
  applyRealtimeEvent,
  requiresSnapshotRefresh,
} from "../lib/orchestration";
import { type RemoteClientConnectionState, RemoteClient } from "../lib/remoteClient";
import {
  type DraftComposerImageAttachment,
  pasteComposerClipboard,
  pickComposerImages,
} from "../lib/composerImages";
import {
  clearSavedConnectionInput,
  loadSavedConnectionInput,
  saveConnectionInput,
} from "../lib/storage";
import {
  buildPendingUserInputAnswers,
  buildThreadFeed,
  derivePendingApprovals,
  derivePendingUserInputs,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
  type QueuedThreadMessage,
} from "../lib/threadActivity";
import { sortCopy } from "../lib/arrayCompat";

export interface RemoteAppModel {
  readonly isLoadingSavedConnection: boolean;
  readonly reconnectingScreenVisible: boolean;
  readonly connectionSheetRequired: boolean;
  readonly connectionInput: RemoteConnectionInput;
  readonly connectionState: RemoteClientConnectionState;
  readonly connectionError: string | null;
  readonly serverConfig: T3ServerConfig | null;
  readonly projects: ReadonlyArray<OrchestrationReadModel["projects"][number]>;
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly selectedThread: OrchestrationThread | null;
  readonly projectNameById: Map<string, string>;
  readonly selectedThreadFeed: ReturnType<typeof buildThreadFeed>;
  readonly selectedThreadFeedLoadingInitial: boolean;
  readonly selectedThreadFeedLoadingMore: boolean;
  readonly selectedThreadFeedHasMore: boolean;
  readonly selectedThreadQueueCount: number;
  readonly activeWorkDurationLabel: string | null;
  readonly activePendingApproval: ReturnType<typeof derivePendingApprovals>[number] | null;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly activePendingUserInput: ReturnType<typeof derivePendingUserInputs>[number] | null;
  readonly activePendingUserInputDrafts: Record<string, PendingUserInputDraftAnswer>;
  readonly activePendingUserInputAnswers: Record<string, string> | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly screenTone: ReturnType<typeof connectionTone>;
  readonly activeThreadBusy: boolean;
  readonly hasRemoteActivity: boolean;
  readonly resolvedServerUrl: string | null;
  readonly httpOrigin: string | null;
  readonly resolvedAuthToken: string | null;
  readonly hasClient: boolean;
  readonly heroTitle: string;
  readonly showBrandWordmark: boolean;
  readonly onOpenConnectionEditor: () => void;
  readonly onCloseConnectionEditor: () => void;
  readonly onRequestCloseConnectionEditor: () => void;
  readonly onChangeConnectionServerUrl: (serverUrl: string) => void;
  readonly onChangeConnectionAuthToken: (authToken: string) => void;
  readonly onConnectPress: () => void;
  readonly onDisconnectPress: () => void;
  readonly onForgetConnectionPress: () => void;
  readonly onRefresh: () => Promise<void>;
  readonly onCreateThread: (projectId: ProjectId) => Promise<void>;
  readonly onSelectThread: (threadId: OrchestrationThread["id"]) => void;
  readonly onLoadMoreSelectedThreadFeed: () => Promise<void>;
  readonly onBackFromThread: () => void;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftImages: () => Promise<void>;
  readonly onPasteIntoDraft: () => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onSendMessage: () => void;
  readonly onRenameThread: (title: string) => Promise<void>;
  readonly onStopThread: () => Promise<void>;
  readonly onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  readonly onSelectUserInputOption: (requestId: string, questionId: string, label: string) => void;
  readonly onChangeUserInputCustomAnswer: (
    requestId: string,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmitUserInput: () => Promise<void>;
}

const THREAD_MESSAGES_PAGE_SIZE = 5;
const CONNECTION_SHEET_GRACE_MS = 2500;

type ThreadMessagePageState = {
  readonly messagesNewestFirst: ReadonlyArray<OrchestrationThread["messages"][number]>;
  readonly hasMore: boolean;
  readonly loaded: boolean;
  readonly loadingInitial: boolean;
  readonly loadingMore: boolean;
};

function emptyThreadMessagePageState(): ThreadMessagePageState {
  return {
    messagesNewestFirst: [],
    hasMore: false,
    loaded: false,
    loadingInitial: false,
    loadingMore: false,
  };
}

function initialThreadMessagePageState(
  thread: OrchestrationThread,
  pageSize: number,
): ThreadMessagePageState {
  return {
    messagesNewestFirst: sortCopy(thread.messages, compareThreadMessagesNewestFirst),
    hasMore: thread.messages.length >= pageSize,
    loaded: true,
    loadingInitial: false,
    loadingMore: false,
  };
}

function compareThreadMessagesNewestFirst(
  left: OrchestrationThread["messages"][number],
  right: OrchestrationThread["messages"][number],
): number {
  const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }
  return right.id.localeCompare(left.id);
}

function mergeThreadMessagesNewestFirst(
  current: ReadonlyArray<OrchestrationThread["messages"][number]>,
  incoming: ReadonlyArray<OrchestrationThread["messages"][number]>,
): ReadonlyArray<OrchestrationThread["messages"][number]> {
  const messageById = new Map<string, OrchestrationThread["messages"][number]>();

  for (const message of current) {
    messageById.set(message.id, message);
  }
  for (const message of incoming) {
    messageById.set(message.id, message);
  }

  return sortCopy(Array.from(messageById.values()), compareThreadMessagesNewestFirst);
}

function resolveNewThreadModelSelection(input: {
  readonly projectId: ProjectId;
  readonly projects: ReadonlyArray<OrchestrationReadModel["projects"][number]>;
  readonly threads: ReadonlyArray<OrchestrationThread>;
}) {
  const project = input.projects.find((candidate) => candidate.id === input.projectId);
  if (project?.defaultModelSelection) {
    return project.defaultModelSelection;
  }

  const latestProjectThread = input.threads.find((thread) => thread.projectId === input.projectId);
  if (latestProjectThread) {
    return latestProjectThread.modelSelection;
  }

  return null;
}

function useStartupConnection({
  connectFromDeepLink,
  connectToRemote,
  setConnectionInput,
  setConnectionEditorVisible,
  setIsLoadingSavedConnection,
  clearConnectionSheetGraceTimer,
  disconnectClient,
}: {
  readonly connectFromDeepLink: (
    url: string,
    options?: { readonly persist?: boolean; readonly startSheetGrace?: boolean },
  ) => Promise<boolean>;
  readonly connectToRemote: (
    input: RemoteConnectionInput,
    options?: { readonly persist?: boolean; readonly startSheetGrace?: boolean },
  ) => Promise<void>;
  readonly setConnectionInput: (input: RemoteConnectionInput) => void;
  readonly setConnectionEditorVisible: (visible: boolean) => void;
  readonly setIsLoadingSavedConnection: (loading: boolean) => void;
  readonly clearConnectionSheetGraceTimer: () => void;
  readonly disconnectClient: () => void;
}) {
  useEffect(() => {
    let cancelled = false;

    void Promise.all([Linking.getInitialURL(), loadSavedConnectionInput()])
      .then(async ([initialUrl, saved]) => {
        if (cancelled) {
          return;
        }
        if (initialUrl && (await connectFromDeepLink(initialUrl, { startSheetGrace: true }))) {
          return;
        }
        if (saved) {
          setConnectionInput(saved);
          void connectToRemote(saved, { persist: false, startSheetGrace: true });
          return;
        }
        setConnectionEditorVisible(true);
      })
      .catch(() => {
        if (!cancelled) {
          setConnectionEditorVisible(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingSavedConnection(false);
        }
      });

    return () => {
      cancelled = true;
      clearConnectionSheetGraceTimer();
      disconnectClient();
    };
  }, [
    connectFromDeepLink,
    connectToRemote,
    setConnectionInput,
    setConnectionEditorVisible,
    setIsLoadingSavedConnection,
    clearConnectionSheetGraceTimer,
    disconnectClient,
  ]);
}

function useDeepLinkListener(
  connectFromDeepLink: (
    url: string,
    options?: { readonly persist?: boolean; readonly startSheetGrace?: boolean },
  ) => Promise<boolean>,
) {
  useEffect(() => {
    const subscription = Linking.addEventListener("url", (event) => {
      void connectFromDeepLink(event.url, { startSheetGrace: true });
    });

    return () => {
      subscription.remove();
    };
  }, [connectFromDeepLink]);
}

function useThreadMessageSync(
  selectedThread: OrchestrationThread | null,
  selectedThreadMessagePage: ThreadMessagePageState | null,
  setThreadMessagePagesByThreadId: React.Dispatch<
    React.SetStateAction<Record<string, ThreadMessagePageState>>
  >,
) {
  useEffect(() => {
    if (!selectedThread || !selectedThreadMessagePage?.loaded) {
      return;
    }

    setThreadMessagePagesByThreadId((current) => {
      const existing = current[selectedThread.id];
      if (!existing?.loaded) {
        return current;
      }

      const newestLoadedCreatedAt = existing.messagesNewestFirst[0]?.createdAt ?? null;
      const nextMessages = mergeThreadMessagesNewestFirst(
        existing.messagesNewestFirst,
        selectedThread.messages.filter((message) =>
          newestLoadedCreatedAt === null
            ? true
            : message.createdAt >= newestLoadedCreatedAt ||
              existing.messagesNewestFirst.some((m) => m.id === message.id),
        ),
      );

      if (
        nextMessages.length === existing.messagesNewestFirst.length &&
        nextMessages.every((message, index) => message === existing.messagesNewestFirst[index])
      ) {
        return current;
      }

      return {
        ...current,
        [selectedThread.id]: {
          ...existing,
          messagesNewestFirst: nextMessages,
        },
      };
    });
  }, [selectedThread, selectedThreadMessagePage, setThreadMessagePagesByThreadId]);
}

function useOrphanThreadCleanup(
  selectedThreadId: OrchestrationThread["id"] | null,
  selectedThread: OrchestrationThread | null,
  setSelectedThreadId: (id: OrchestrationThread["id"] | null) => void,
) {
  useEffect(() => {
    if (selectedThreadId && !selectedThread) {
      setSelectedThreadId(null);
    }
  }, [selectedThread, selectedThreadId, setSelectedThreadId]);
}

function useWorkDurationTicker(
  activeWorkStartedAt: string | null,
  setNowTick: (tick: number) => void,
) {
  useEffect(() => {
    if (!activeWorkStartedAt) {
      return;
    }

    setNowTick(Date.now());
    const timer = setInterval(() => {
      setNowTick(Date.now());
    }, 1_000);

    return () => clearInterval(timer);
  }, [activeWorkStartedAt, setNowTick]);
}

function useQueueDrain({
  connectionState,
  dispatchingQueuedMessageId,
  sendingThreadId,
  queuedMessagesByThreadId,
  threads,
  sendQueuedMessage,
}: {
  readonly connectionState: RemoteClientConnectionState;
  readonly dispatchingQueuedMessageId: string | null;
  readonly sendingThreadId: OrchestrationThread["id"] | null;
  readonly queuedMessagesByThreadId: Record<string, ReadonlyArray<QueuedThreadMessage>>;
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly sendQueuedMessage: (message: QueuedThreadMessage) => Promise<void>;
}) {
  useEffect(() => {
    if (
      connectionState !== "ready" ||
      dispatchingQueuedMessageId !== null ||
      sendingThreadId !== null
    ) {
      return;
    }

    for (const [threadId, queuedMessages] of Object.entries(queuedMessagesByThreadId)) {
      const nextQueuedMessage = queuedMessages[0];
      if (!nextQueuedMessage) {
        continue;
      }

      const thread = threads.find((candidate) => candidate.id === threadId);
      const threadStatus = thread?.session?.status;
      if (threadStatus === "running" || threadStatus === "starting") {
        continue;
      }

      void sendQueuedMessage(nextQueuedMessage);
      return;
    }
  }, [
    connectionState,
    dispatchingQueuedMessageId,
    sendingThreadId,
    queuedMessagesByThreadId,
    threads,
    sendQueuedMessage,
  ]);
}

export function useRemoteAppState(): RemoteAppModel {
  const clientRef = useRef<RemoteClient | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionSheetGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionAttemptRef = useRef(0);
  const [isLoadingSavedConnection, setIsLoadingSavedConnection] = useState(true);
  const [connectionEditorVisible, setConnectionEditorVisible] = useState(false);
  const [connectionSheetGraceActive, setConnectionSheetGraceActive] = useState(false);
  const [suppressAutoConnectionSheet, setSuppressAutoConnectionSheet] = useState(false);
  const [connectionInput, setConnectionInput] = useState<RemoteConnectionInput>({
    serverUrl: "",
    authToken: "",
  });
  const [resolvedServerUrl, setResolvedServerUrl] = useState<string | null>(null);
  const [httpOrigin, setHttpOrigin] = useState<string | null>(null);
  const [resolvedAuthToken, setResolvedAuthToken] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<RemoteClientConnectionState>("idle");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<OrchestrationReadModel | null>(null);
  const [serverConfig, setServerConfig] = useState<T3ServerConfig | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<OrchestrationThread["id"] | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [draftMessageByThreadId, setDraftMessageByThreadId] = useState<Record<string, string>>({});
  const [draftAttachmentsByThreadId, setDraftAttachmentsByThreadId] = useState<
    Record<string, ReadonlyArray<DraftComposerImageAttachment>>
  >({});
  const [sendingThreadId, setSendingThreadId] = useState<OrchestrationThread["id"] | null>(null);
  const [respondingApprovalId, setRespondingApprovalId] = useState<ApprovalRequestId | null>(null);
  const [respondingUserInputId, setRespondingUserInputId] = useState<ApprovalRequestId | null>(
    null,
  );
  const [dispatchingQueuedMessageId, setDispatchingQueuedMessageId] = useState<string | null>(null);
  const [queuedMessagesByThreadId, setQueuedMessagesByThreadId] = useState<
    Record<string, ReadonlyArray<QueuedThreadMessage>>
  >({});
  const [threadMessagePagesByThreadId, setThreadMessagePagesByThreadId] = useState<
    Record<string, ThreadMessagePageState>
  >({});
  const [userInputDraftsByRequestId, setUserInputDraftsByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const clearConnectionSheetGraceTimer = useCallback(() => {
    if (connectionSheetGraceTimerRef.current !== null) {
      clearTimeout(connectionSheetGraceTimerRef.current);
      connectionSheetGraceTimerRef.current = null;
    }
  }, []);

  const startConnectionSheetGrace = useCallback(() => {
    clearConnectionSheetGraceTimer();
    setConnectionSheetGraceActive(true);
    connectionSheetGraceTimerRef.current = setTimeout(() => {
      connectionSheetGraceTimerRef.current = null;
      setConnectionSheetGraceActive(false);
    }, CONNECTION_SHEET_GRACE_MS);
  }, [clearConnectionSheetGraceTimer]);

  const disconnectClient = useCallback(
    (options?: { readonly invalidatePendingConnection?: boolean }) => {
      if (options?.invalidatePendingConnection !== false) {
        connectionAttemptRef.current += 1;
      }

      clearRefreshTimer();
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      clientRef.current?.disconnect();
      clientRef.current = null;
    },
    [clearRefreshTimer],
  );

  const refreshSnapshot = useCallback(async () => {
    const client = clientRef.current;
    if (!client) {
      return;
    }

    try {
      const nextSnapshot = await client.refreshSnapshot();
      setSnapshot(nextSnapshot);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "Failed to refresh snapshot.");
    }
  }, []);

  const scheduleSnapshotRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      return;
    }

    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshSnapshot();
    }, 180);
  }, [refreshSnapshot]);

  const connectToRemote = useCallback(
    async (
      input: RemoteConnectionInput,
      options?: { readonly persist?: boolean; readonly startSheetGrace?: boolean },
    ) => {
      const attemptId = connectionAttemptRef.current + 1;
      connectionAttemptRef.current = attemptId;

      if (options?.startSheetGrace) {
        startConnectionSheetGrace();
      } else {
        clearConnectionSheetGraceTimer();
        setConnectionSheetGraceActive(false);
      }

      let resolved;
      try {
        resolved = resolveRemoteConnection(input);
      } catch (error) {
        setConnectionError(
          error instanceof Error ? error.message : "Enter a valid server URL to continue.",
        );
        return;
      }

      try {
        await preflightRemoteConnection(resolved);
      } catch (error) {
        if (connectionAttemptRef.current !== attemptId) {
          return;
        }
        setConnectionError(
          error instanceof Error ? error.message : "Failed to reach the T3 server.",
        );
        return;
      }

      if (connectionAttemptRef.current !== attemptId) {
        return;
      }

      disconnectClient({ invalidatePendingConnection: false });
      setSuppressAutoConnectionSheet(false);
      setConnectionError(null);
      setSnapshot(null);
      setServerConfig(null);
      setSelectedThreadId(null);
      setDraftMessageByThreadId({});
      setDraftAttachmentsByThreadId({});
      setQueuedMessagesByThreadId({});
      setThreadMessagePagesByThreadId({});
      setDispatchingQueuedMessageId(null);
      setResolvedServerUrl(resolved.displayUrl);
      setHttpOrigin(resolved.httpOrigin);
      setResolvedAuthToken(resolved.authToken);
      setConnectionState("connecting");

      if (options?.persist !== false) {
        await saveConnectionInput({
          serverUrl: input.serverUrl.trim(),
          authToken: input.authToken.trim(),
        });
      }

      if (connectionAttemptRef.current !== attemptId) {
        return;
      }

      const client = new RemoteClient(resolved);
      clientRef.current = client;

      unsubscribeRef.current = client.addListener((event) => {
        switch (event.type) {
          case "status":
            setConnectionState(event.state);
            setConnectionError(event.error ?? null);
            if (event.state === "ready") {
              clearConnectionSheetGraceTimer();
              setConnectionSheetGraceActive(false);
            }
            return;
          case "server-config":
            setServerConfig(event.config);
            return;
          case "snapshot":
            setSnapshot(event.snapshot);
            setSelectedThreadId((current) => {
              if (
                current &&
                event.snapshot.threads.some(
                  (thread) => thread.id === current && thread.deletedAt === null,
                )
              ) {
                return current;
              }
              return null;
            });
            return;
          case "domain-event":
            setSnapshot((current) => {
              if (!current) {
                return current;
              }
              return applyRealtimeEvent(current, event.event);
            });
            if (requiresSnapshotRefresh(event.event)) {
              scheduleSnapshotRefresh();
            }
            return;
        }
      });

      client.connect();
      setConnectionEditorVisible(false);
    },
    [
      clearConnectionSheetGraceTimer,
      disconnectClient,
      scheduleSnapshotRefresh,
      startConnectionSheetGrace,
    ],
  );

  const connectFromDeepLink = useCallback(
    async (
      url: string,
      options?: { readonly persist?: boolean; readonly startSheetGrace?: boolean },
    ) => {
      const parsed = parseRemoteAppConnectionUrl(url);
      if (!parsed) {
        return false;
      }

      setSuppressAutoConnectionSheet(false);
      setConnectionEditorVisible(false);
      setConnectionInput({
        serverUrl: parsed.serverUrl,
        authToken: parsed.authToken ?? "",
      });
      await connectToRemote(
        {
          serverUrl: parsed.serverUrl,
          authToken: parsed.authToken ?? "",
        },
        options,
      );
      return true;
    },
    [connectToRemote],
  );

  useStartupConnection({
    connectFromDeepLink,
    connectToRemote,
    setConnectionInput,
    setConnectionEditorVisible,
    setIsLoadingSavedConnection,
    clearConnectionSheetGraceTimer,
    disconnectClient,
  });

  useDeepLinkListener(connectFromDeepLink);

  const projects = useMemo(() => {
    if (!snapshot) {
      return [];
    }

    return sortCopy(
      snapshot.projects.filter((project) => project.deletedAt === null),
      (left, right) => left.title.localeCompare(right.title),
    );
  }, [snapshot]);

  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) {
      map.set(project.id, project.title);
    }
    return map;
  }, [projects]);

  const threads = useMemo(() => {
    if (!snapshot) {
      return [];
    }

    return sortCopy(
      snapshot.threads.filter((thread) => thread.deletedAt === null),
      (left, right) => threadSortValue(right) - threadSortValue(left),
    );
  }, [snapshot]);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [selectedThreadId, threads],
  );

  const selectedThreadMessagePage = useMemo(
    () =>
      selectedThread
        ? (threadMessagePagesByThreadId[selectedThread.id] ?? emptyThreadMessagePageState())
        : null,
    [selectedThread, threadMessagePagesByThreadId],
  );

  const loadThreadMessagesPage = useCallback(
    async (threadId: OrchestrationThread["id"], mode: "initial" | "more") => {
      const client = clientRef.current;
      if (!client) {
        return;
      }

      let offset = 0;
      let shouldSkip = false;

      setThreadMessagePagesByThreadId((current) => {
        const currentPage = current[threadId] ?? emptyThreadMessagePageState();
        if (mode === "initial" && currentPage.loadingInitial) {
          shouldSkip = true;
          return current;
        }
        if (
          mode === "more" &&
          (currentPage.loadingInitial || currentPage.loadingMore || !currentPage.hasMore)
        ) {
          shouldSkip = true;
          return current;
        }

        offset = mode === "initial" ? 0 : currentPage.messagesNewestFirst.length;
        return {
          ...current,
          [threadId]: {
            ...(mode === "initial" ? emptyThreadMessagePageState() : currentPage),
            messagesNewestFirst: mode === "initial" ? [] : currentPage.messagesNewestFirst,
            hasMore: mode === "initial" ? false : currentPage.hasMore,
            loaded: mode === "initial" ? false : currentPage.loaded,
            loadingInitial: mode === "initial",
            loadingMore: mode === "more",
          },
        };
      });

      if (shouldSkip) {
        return;
      }

      try {
        const result = await client.getThreadMessagesPage({
          threadId,
          offset,
          limit: THREAD_MESSAGES_PAGE_SIZE,
        });
        setThreadMessagePagesByThreadId((current) => {
          const previous =
            mode === "initial"
              ? emptyThreadMessagePageState()
              : (current[threadId] ?? emptyThreadMessagePageState());

          return {
            ...current,
            [threadId]: {
              messagesNewestFirst:
                mode === "initial"
                  ? result.messages
                  : mergeThreadMessagesNewestFirst(previous.messagesNewestFirst, result.messages),
              hasMore: result.hasMore,
              loaded: true,
              loadingInitial: false,
              loadingMore: false,
            },
          };
        });
      } catch (error) {
        setConnectionError(
          error instanceof Error ? error.message : "Failed to load thread messages.",
        );
        setThreadMessagePagesByThreadId((current) => ({
          ...current,
          [threadId]: {
            ...(current[threadId] ?? emptyThreadMessagePageState()),
            loadingInitial: false,
            loadingMore: false,
          },
        }));
      }
    },
    [],
  );

  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThread ? (queuedMessagesByThreadId[selectedThread.id] ?? []) : []),
    [queuedMessagesByThreadId, selectedThread],
  );
  const queuedSendStartedAt = selectedThreadQueuedMessages[0]?.createdAt ?? null;

  const selectedThreadLoadedMessages = useMemo(
    () =>
      selectedThreadMessagePage?.loaded
        ? sortCopy(
            selectedThreadMessagePage.messagesNewestFirst,
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
        : [],
    [selectedThreadMessagePage],
  );

  const selectedThreadFeed = useMemo(
    () =>
      selectedThread
        ? buildThreadFeed(
            selectedThread,
            selectedThreadQueuedMessages,
            dispatchingQueuedMessageId,
            selectedThreadMessagePage?.loaded
              ? { loadedMessages: selectedThreadLoadedMessages }
              : undefined,
          )
        : [],
    [
      dispatchingQueuedMessageId,
      selectedThread,
      selectedThreadMessagePage?.loaded,
      selectedThreadLoadedMessages,
      selectedThreadQueuedMessages,
    ],
  );
  const draftMessage = selectedThread ? (draftMessageByThreadId[selectedThread.id] ?? "") : "";
  const draftAttachments = selectedThread
    ? (draftAttachmentsByThreadId[selectedThread.id] ?? [])
    : [];

  useThreadMessageSync(selectedThread, selectedThreadMessagePage, setThreadMessagePagesByThreadId);

  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;

  const selectedThreadSessionActivity = useMemo(() => {
    if (!selectedThread?.session) {
      return null;
    }
    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    };
  }, [selectedThread]);

  const activeWorkStartedAt = useMemo(() => {
    if (!selectedThread) {
      return null;
    }
    return deriveActiveWorkStartedAt(
      selectedThread.latestTurn,
      selectedThreadSessionActivity,
      queuedSendStartedAt,
    );
  }, [queuedSendStartedAt, selectedThread, selectedThreadSessionActivity]);

  const activeWorkDurationLabel = useMemo(
    () =>
      activeWorkStartedAt
        ? formatElapsed(activeWorkStartedAt, new Date(nowTick).toISOString())
        : null,
    [activeWorkStartedAt, nowTick],
  );

  useOrphanThreadCleanup(selectedThreadId, selectedThread, setSelectedThreadId);
  useWorkDurationTicker(activeWorkStartedAt, setNowTick);

  const activePendingApprovals = useMemo(
    () => (selectedThread ? derivePendingApprovals(selectedThread.activities) : []),
    [selectedThread],
  );
  const activePendingApproval = activePendingApprovals[0] ?? null;

  const activePendingUserInputs = useMemo(
    () => (selectedThread ? derivePendingUserInputs(selectedThread.activities) : []),
    [selectedThread],
  );
  const activePendingUserInput = activePendingUserInputs[0] ?? null;
  const activePendingUserInputDrafts = activePendingUserInput
    ? (userInputDraftsByRequestId[activePendingUserInput.requestId] ?? {})
    : {};
  const activePendingUserInputAnswers = activePendingUserInput
    ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingUserInputDrafts)
    : null;

  const screenTone = connectionTone(connectionState);
  const activeThreadBusy =
    !!selectedThread &&
    (selectedThread.session?.status === "running" ||
      selectedThread.session?.status === "starting") &&
    sendingThreadId !== selectedThread.id;
  const hasRemoteActivity = useMemo(
    () =>
      threads.some(
        (thread) => thread.session?.status === "running" || thread.session?.status === "starting",
      ),
    [threads],
  );

  const enqueueThreadMessage = useCallback((queuedMessage: QueuedThreadMessage) => {
    setQueuedMessagesByThreadId((current) => ({
      ...current,
      [queuedMessage.threadId]: [...(current[queuedMessage.threadId] ?? []), queuedMessage],
    }));
  }, []);

  const removeQueuedMessage = useCallback((threadId: string, queuedMessageId: string) => {
    setQueuedMessagesByThreadId((current) => {
      const existing = current[threadId];
      if (!existing) {
        return current;
      }

      const nextQueue = existing.filter((entry) => entry.id !== queuedMessageId);
      if (nextQueue.length === existing.length) {
        return current;
      }
      if (nextQueue.length === 0) {
        const next = { ...current };
        delete next[threadId];
        return next;
      }
      return {
        ...current,
        [threadId]: nextQueue,
      };
    });
  }, []);

  const clearQueuedMessagesForThread = useCallback((threadId: string) => {
    setQueuedMessagesByThreadId((current) => {
      if (!(threadId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[threadId];
      return next;
    });
  }, []);

  const onRefresh = useCallback(async () => {
    const client = clientRef.current;
    if (!client) {
      return;
    }

    try {
      const [nextConfig, nextSnapshot] = await Promise.all([
        client.refreshServerConfig(),
        client.refreshSnapshot(),
      ]);
      setServerConfig(nextConfig);
      setSnapshot(nextSnapshot);
      setConnectionError(null);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "Failed to refresh remote data.");
    }
  }, []);

  const onCreateThread = useCallback(
    async (projectId: ProjectId) => {
      const client = clientRef.current;
      if (!client || connectionState !== "ready") {
        return;
      }

      const modelSelection = resolveNewThreadModelSelection({
        projectId,
        projects,
        threads,
      });
      if (!modelSelection) {
        setConnectionError("This project does not have a default model configured yet.");
        return;
      }

      const threadId = ThreadId.makeUnsafe(newClientId("thread"));
      const createdAt = new Date().toISOString();

      try {
        await client.dispatchCommand({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(newClientId("command")),
          threadId,
          projectId,
          title: "New thread",
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt,
        });
        const nextSnapshot = await client.refreshSnapshot();
        setSnapshot(nextSnapshot);
        setSelectedThreadId(threadId);
        setConnectionError(null);
      } catch (error) {
        setConnectionError(error instanceof Error ? error.message : "Failed to create thread.");
      }
    },
    [connectionState, projects, threads],
  );

  const onLoadMoreSelectedThreadFeed = useCallback(async () => {
    if (!selectedThread) {
      return;
    }
    await loadThreadMessagesPage(selectedThread.id, "more");
  }, [loadThreadMessagesPage, selectedThread]);

  const onConnectPress = useCallback(() => {
    setSuppressAutoConnectionSheet(false);
    void connectToRemote(connectionInput);
  }, [connectToRemote, connectionInput]);

  const onDisconnectPress = useCallback(() => {
    clearConnectionSheetGraceTimer();
    setConnectionSheetGraceActive(false);
    setConnectionEditorVisible(false);
    setSuppressAutoConnectionSheet(true);
    disconnectClient();
    setConnectionState("idle");
    setConnectionError(null);
    setSnapshot(null);
    setServerConfig(null);
    setDraftMessageByThreadId({});
    setDraftAttachmentsByThreadId({});
    setQueuedMessagesByThreadId({});
    setThreadMessagePagesByThreadId({});
    setDispatchingQueuedMessageId(null);
    setResolvedServerUrl(null);
    setHttpOrigin(null);
    setResolvedAuthToken(null);
    setSelectedThreadId(null);
  }, [clearConnectionSheetGraceTimer, disconnectClient]);

  const onForgetConnectionPress = useCallback(() => {
    Alert.alert("Forget saved connection?", "The saved URL and auth token will be removed.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Forget",
        style: "destructive",
        onPress: () => {
          void clearSavedConnectionInput();
          onDisconnectPress();
          setConnectionInput({ serverUrl: "", authToken: "" });
          setConnectionEditorVisible(true);
        },
      },
    ]);
  }, [onDisconnectPress]);

  const sendQueuedMessage = useCallback(
    async (queuedMessage: QueuedThreadMessage) => {
      const client = clientRef.current;
      if (!client) {
        return;
      }

      setDispatchingQueuedMessageId(queuedMessage.id);
      setSendingThreadId(ThreadId.makeUnsafe(queuedMessage.threadId));

      try {
        await client.dispatchCommand({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(queuedMessage.commandId),
          threadId: ThreadId.makeUnsafe(queuedMessage.threadId),
          message: {
            messageId: MessageId.makeUnsafe(queuedMessage.messageId),
            role: "user",
            text: queuedMessage.text,
            attachments: queuedMessage.attachments,
          },
          runtimeMode:
            threads.find((thread) => thread.id === queuedMessage.threadId)?.runtimeMode ??
            "full-access",
          interactionMode:
            threads.find((thread) => thread.id === queuedMessage.threadId)?.interactionMode ??
            "default",
          createdAt: queuedMessage.createdAt,
        });
        removeQueuedMessage(queuedMessage.threadId, queuedMessage.id);
        setSnapshot((current) =>
          current
            ? applyOptimisticUserMessage(current, {
                threadId: ThreadId.makeUnsafe(queuedMessage.threadId),
                messageId: MessageId.makeUnsafe(queuedMessage.messageId),
                text: queuedMessage.text,
                attachments: queuedMessage.attachments,
                createdAt: queuedMessage.createdAt,
              })
            : current,
        );
      } catch (error) {
        removeQueuedMessage(queuedMessage.threadId, queuedMessage.id);
        setConnectionError(error instanceof Error ? error.message : "Failed to send message.");
        void refreshSnapshot();
      } finally {
        setDispatchingQueuedMessageId((current) => (current === queuedMessage.id ? null : current));
        setSendingThreadId((current) =>
          current === ThreadId.makeUnsafe(queuedMessage.threadId) ? null : current,
        );
      }
    },
    [refreshSnapshot, removeQueuedMessage, threads],
  );

  useQueueDrain({
    connectionState,
    dispatchingQueuedMessageId,
    sendingThreadId,
    queuedMessagesByThreadId,
    threads,
    sendQueuedMessage,
  });

  const onSendMessage = useCallback(() => {
    if (!selectedThread || connectionState !== "ready") {
      return;
    }

    const draft = draftMessageByThreadId[selectedThread.id] ?? "";
    const text = draft.trim();
    const attachments = draftAttachmentsByThreadId[selectedThread.id] ?? [];
    if (text.length === 0 && attachments.length === 0) {
      return;
    }

    const createdAt = new Date().toISOString();
    enqueueThreadMessage({
      id: newClientId("queued-message"),
      threadId: selectedThread.id,
      messageId: newClientId("message"),
      commandId: newClientId("command"),
      text,
      attachments,
      createdAt,
    });
    setDraftMessageByThreadId((current) => ({
      ...current,
      [selectedThread.id]: "",
    }));
    setDraftAttachmentsByThreadId((current) => ({
      ...current,
      [selectedThread.id]: [],
    }));
  }, [
    connectionState,
    draftAttachmentsByThreadId,
    draftMessageByThreadId,
    enqueueThreadMessage,
    selectedThread,
  ]);

  const onStopThread = useCallback(async () => {
    if (!selectedThread) {
      return;
    }

    clearQueuedMessagesForThread(selectedThread.id);

    const client = clientRef.current;
    if (!client) {
      return;
    }
    if (
      selectedThread.session?.status !== "running" &&
      selectedThread.session?.status !== "starting"
    ) {
      return;
    }

    try {
      await client.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe(newClientId("command")),
        threadId: selectedThread.id,
        ...(selectedThread.session?.activeTurnId
          ? { turnId: selectedThread.session.activeTurnId }
          : {}),
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "Failed to interrupt turn.");
    }
  }, [clearQueuedMessagesForThread, selectedThread]);

  const onRenameThread = useCallback(
    async (title: string) => {
      const client = clientRef.current;
      if (!client || !selectedThread) {
        return;
      }

      const trimmed = title.trim();
      if (trimmed.length === 0 || trimmed === selectedThread.title) {
        return;
      }

      try {
        await client.dispatchCommand({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe(newClientId("command")),
          threadId: selectedThread.id,
          title: trimmed,
        });
        setConnectionError(null);
      } catch (error) {
        setConnectionError(error instanceof Error ? error.message : "Failed to rename thread.");
      }
    },
    [selectedThread],
  );

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      const client = clientRef.current;
      if (!client || !selectedThread) {
        return;
      }

      setRespondingApprovalId(requestId);
      try {
        await client.dispatchCommand({
          type: "thread.approval.respond",
          commandId: CommandId.makeUnsafe(newClientId("command")),
          threadId: selectedThread.id,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        setConnectionError(
          error instanceof Error ? error.message : "Failed to submit approval response.",
        );
      } finally {
        setRespondingApprovalId((current) => (current === requestId ? null : current));
      }
    },
    [selectedThread],
  );

  const onSelectUserInputOption = useCallback(
    (requestId: string, questionId: string, label: string) => {
      setUserInputDraftsByRequestId((current) => ({
        ...current,
        [requestId]: {
          ...current[requestId],
          [questionId]: {
            selectedOptionLabel: label,
          },
        },
      }));
    },
    [],
  );

  const onChangeUserInputCustomAnswer = useCallback(
    (requestId: string, questionId: string, customAnswer: string) => {
      setUserInputDraftsByRequestId((current) => ({
        ...current,
        [requestId]: {
          ...current[requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            current[requestId]?.[questionId],
            customAnswer,
          ),
        },
      }));
    },
    [],
  );

  const onSubmitUserInput = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !selectedThread || !activePendingUserInput || !activePendingUserInputAnswers) {
      return;
    }

    setRespondingUserInputId(activePendingUserInput.requestId);
    try {
      await client.dispatchCommand({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe(newClientId("command")),
        threadId: selectedThread.id,
        requestId: activePendingUserInput.requestId,
        answers: activePendingUserInputAnswers,
        createdAt: new Date().toISOString(),
      });
      setUserInputDraftsByRequestId((current) => {
        if (!(activePendingUserInput.requestId in current)) {
          return current;
        }

        const next = { ...current };
        delete next[activePendingUserInput.requestId];
        return next;
      });
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : "Failed to submit user input answers.",
      );
    } finally {
      setRespondingUserInputId((current) =>
        current === activePendingUserInput.requestId ? null : current,
      );
    }
  }, [activePendingUserInput, activePendingUserInputAnswers, selectedThread]);

  const onOpenConnectionEditor = useCallback(() => {
    setSuppressAutoConnectionSheet(false);
    setConnectionEditorVisible(true);
  }, []);

  const onCloseConnectionEditor = useCallback(() => setConnectionEditorVisible(false), []);

  const onRequestCloseConnectionEditor = useCallback(() => {
    if (clientRef.current) {
      setConnectionEditorVisible(false);
    }
  }, []);

  const onChangeConnectionServerUrl = useCallback(
    (serverUrl: string) => setConnectionInput((current) => ({ ...current, serverUrl })),
    [],
  );

  const onChangeConnectionAuthToken = useCallback(
    (authToken: string) => setConnectionInput((current) => ({ ...current, authToken })),
    [],
  );

  const onSelectThread = useCallback(
    (threadId: OrchestrationThread["id"]) => {
      const thread = threads.find((candidate) => candidate.id === threadId) ?? null;
      setSelectedThreadId(threadId);
      setThreadMessagePagesByThreadId((current) => {
        if (current[threadId]?.loaded || !thread) {
          return current;
        }

        return {
          ...current,
          [threadId]: initialThreadMessagePageState(thread, THREAD_MESSAGES_PAGE_SIZE),
        };
      });
    },
    [threads],
  );

  const onBackFromThread = useCallback(() => setSelectedThreadId(null), []);

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThread) {
        return;
      }
      setDraftMessageByThreadId((current) => ({
        ...current,
        [selectedThread.id]: value,
      }));
    },
    [selectedThread],
  );

  const onPickDraftImages = useCallback(async () => {
    if (!selectedThread) {
      return;
    }

    const result = await pickComposerImages({
      existingCount: draftAttachmentsByThreadId[selectedThread.id]?.length ?? 0,
    });
    if (result.images.length > 0) {
      setDraftAttachmentsByThreadId((current) => ({
        ...current,
        [selectedThread.id]: [...(current[selectedThread.id] ?? []), ...result.images],
      }));
    }
    if (result.error) {
      setConnectionError(result.error);
    }
  }, [draftAttachmentsByThreadId, selectedThread]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThread) {
      return;
    }

    const result = await pasteComposerClipboard({
      existingCount: draftAttachmentsByThreadId[selectedThread.id]?.length ?? 0,
    });
    if (result.images.length > 0) {
      setDraftAttachmentsByThreadId((current) => ({
        ...current,
        [selectedThread.id]: [...(current[selectedThread.id] ?? []), ...result.images],
      }));
    }
    if (result.text) {
      setDraftMessageByThreadId((current) => ({
        ...current,
        [selectedThread.id]: `${current[selectedThread.id] ?? ""}${result.text}`,
      }));
    }
    if (result.error) {
      setConnectionError(result.error);
    }
  }, [draftAttachmentsByThreadId, selectedThread]);

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThread) {
        return;
      }
      setDraftAttachmentsByThreadId((current) => {
        const existing = current[selectedThread.id] ?? [];
        const next = existing.filter((image) => image.id !== imageId);
        if (next.length === existing.length) {
          return current;
        }
        return {
          ...current,
          [selectedThread.id]: next,
        };
      });
    },
    [selectedThread],
  );

  const hasClient = clientRef.current !== null;
  const reconnectingScreenVisible =
    connectionSheetGraceActive && !connectionEditorVisible && connectionState !== "ready";
  const connectionSheetRequired =
    connectionEditorVisible ||
    (!hasClient && !connectionSheetGraceActive && !suppressAutoConnectionSheet);
  const heroTitle = screenTitle(serverConfig, resolvedServerUrl);
  const showBrandWordmark = /^t3[-_\s]?code$/i.test(heroTitle);

  return {
    isLoadingSavedConnection,
    reconnectingScreenVisible,
    connectionSheetRequired,
    connectionInput,
    connectionState,
    connectionError,
    serverConfig,
    projects,
    threads,
    selectedThread,
    projectNameById,
    selectedThreadFeed,
    selectedThreadFeedLoadingInitial: selectedThreadMessagePage?.loadingInitial ?? false,
    selectedThreadFeedLoadingMore: selectedThreadMessagePage?.loadingMore ?? false,
    selectedThreadFeedHasMore: selectedThreadMessagePage?.hasMore ?? false,
    selectedThreadQueueCount,
    activeWorkDurationLabel,
    activePendingApproval,
    respondingApprovalId,
    activePendingUserInput,
    activePendingUserInputDrafts,
    activePendingUserInputAnswers,
    respondingUserInputId,
    draftMessage,
    draftAttachments,
    screenTone,
    activeThreadBusy,
    hasRemoteActivity,
    resolvedServerUrl,
    httpOrigin,
    resolvedAuthToken,
    hasClient,
    heroTitle,
    showBrandWordmark,
    onOpenConnectionEditor: onOpenConnectionEditor,
    onCloseConnectionEditor: onCloseConnectionEditor,
    onRequestCloseConnectionEditor: onRequestCloseConnectionEditor,
    onChangeConnectionServerUrl: onChangeConnectionServerUrl,
    onChangeConnectionAuthToken: onChangeConnectionAuthToken,
    onConnectPress,
    onDisconnectPress,
    onForgetConnectionPress,
    onRefresh,
    onCreateThread,
    onSelectThread: onSelectThread,
    onLoadMoreSelectedThreadFeed,
    onBackFromThread: onBackFromThread,
    onChangeDraftMessage: onChangeDraftMessage,
    onPickDraftImages: onPickDraftImages,
    onPasteIntoDraft: onPasteIntoDraft,
    onRemoveDraftImage: onRemoveDraftImage,
    onSendMessage,
    onRenameThread,
    onStopThread,
    onRespondToApproval,
    onSelectUserInputOption,
    onChangeUserInputCustomAnswer,
    onSubmitUserInput,
  };
}
