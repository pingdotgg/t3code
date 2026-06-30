import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState, Linking, Pressable, ScrollView, View } from "react-native";
import {
  BoardId,
  EnvironmentId,
  LaneKey,
  TicketId,
  type StepRunId,
  type WorkflowTicketDetailView,
  type WorkflowTicketMessageView,
} from "@t3tools/contracts";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import {
  getEnvironmentClient,
  subscribeEnvironmentConnections,
} from "../../state/environment-session-registry";
import { useEnvironmentRuntime } from "../../state/use-environment-runtime";
import { useSavedRemoteConnections, useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { isTicketSourceOwned, selectTicketAffordance } from "./ticketAffordance";

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

export function TicketActionSheetScreen() {
  const params = useLocalSearchParams<{
    environmentId?: string | string[];
    boardId?: string | string[];
    ticketId?: string | string[];
  }>();

  const environmentIdRaw = firstRouteParam(params.environmentId);
  const boardIdRaw = firstRouteParam(params.boardId);
  const ticketIdRaw = firstRouteParam(params.ticketId);

  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const ticketId = ticketIdRaw ? TicketId.make(ticketIdRaw) : null;
  // boardId is part of the deep-link contract; surfaced for parity with routing.
  const boardId = boardIdRaw ? BoardId.make(boardIdRaw) : null;

  const [detail, setDetail] = useState<WorkflowTicketDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [answerText, setAnswerText] = useState("");
  const [commentText, setCommentText] = useState("");

  const { isLoadingSavedConnection } = useSavedRemoteConnections();
  const { connectionError: pendingConnectionError } = useRemoteConnectionStatus();
  const routeEnvironmentRuntime = useEnvironmentRuntime(environmentId);
  const routeConnectionState = routeEnvironmentRuntime.connectionState;
  const routeConnectionError = pendingConnectionError ?? routeEnvironmentRuntime.connectionError;

  // Re-read the environment client whenever a connection connects/disconnects so
  // a cold-start notification tap (session not yet connected at first render)
  // picks up the session as soon as bootstrap finishes.
  const subscribeConnections = useCallback(
    (onStoreChange: () => void) => subscribeEnvironmentConnections(onStoreChange),
    [],
  );
  const getSessionSnapshot = useCallback(
    () => (environmentId ? getEnvironmentClient(environmentId) : null),
    [environmentId],
  );
  const session = useSyncExternalStore(
    subscribeConnections,
    getSessionSnapshot,
    getSessionSnapshot,
  );

  // Still hydrating: saved connections are loading, or the route's environment is
  // mid-(re)connect. Drives "Connecting…" instead of the terminal disconnected state.
  const stillHydrating =
    isLoadingSavedConnection ||
    routeConnectionState === "connecting" ||
    routeConnectionState === "reconnecting";

  const refetch = useCallback(async () => {
    if (!session || !ticketId) {
      return;
    }
    const next = await session.workflow.getTicketDetail({ ticketId });
    setDetail(next);
  }, [session, ticketId]);

  useEffect(() => {
    if (!session || !ticketId) {
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    void (async () => {
      try {
        const next = await session.workflow.getTicketDetail({ ticketId });
        if (!cancelled) {
          setDetail(next);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Failed to load ticket.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session, ticketId]);

  // Keep a stable handle to the latest refetch so the focus/foreground listeners
  // below don't re-subscribe (and don't re-fire) whenever refetch's identity
  // changes. Affordances/messages can go stale while the sheet is backgrounded
  // (agent timeout, another client resolves the step, the ticket moves lanes), so
  // refresh silently on re-focus and on app-foreground — mirroring the inbox's
  // useFocusEffect refresh. Failures are swallowed: the existing detail stays
  // shown and we retry on the next focus/foreground.
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  // Skip the very first focus pass: the initial-load effect already fetched.
  const focusedOnceRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!focusedOnceRef.current) {
        focusedOnceRef.current = true;
        return;
      }
      void refetchRef.current().catch(() => undefined);
    }, []),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        void refetchRef.current().catch(() => undefined);
      }
    });
    return () => subscription.remove();
  }, []);

  const runMutation = useCallback(
    async (mutate: () => Promise<unknown>) => {
      setBusy(true);
      setMutationError(null);
      try {
        await mutate();
      } catch (error) {
        setMutationError(error instanceof Error ? error.message : "Action failed.");
        return;
      } finally {
        setBusy(false);
      }
      // The mutation succeeded server-side; refetch separately so a transient
      // detail-load failure (WebSocket drop, ticket momentarily unavailable after
      // its own transition) is NOT surfaced as a mutation error and doesn't prompt
      // a destructive retry of an already-applied action. The focus/foreground
      // refresh below reconciles the view if this refresh is missed.
      try {
        await refetch();
      } catch {
        // Intentionally ignored — the action was applied; stale detail self-heals
        // on the next focus/foreground refetch.
      }
    },
    [refetch],
  );

  const onSubmitAnswer = useCallback(
    (stepRunId: StepRunId) => {
      const text = answerText.trim();
      if (!session || text.length === 0) {
        return;
      }
      void runMutation(async () => {
        await session.workflow.answerTicketStep({ stepRunId, text });
        setAnswerText("");
      });
    },
    [answerText, runMutation, session],
  );

  const onResolveApproval = useCallback(
    (stepRunId: StepRunId, approved: boolean) => {
      if (!session) {
        return;
      }
      void runMutation(() => session.workflow.resolveApproval({ stepRunId, approved }));
    },
    [runMutation, session],
  );

  const onMoveTicket = useCallback(
    (toLane: LaneKey) => {
      if (!session || !ticketId) {
        return;
      }
      void runMutation(() => session.workflow.moveTicket({ ticketId, toLane }));
    },
    [runMutation, session, ticketId],
  );

  const onPostComment = useCallback(() => {
    const text = commentText.trim();
    if (!session || !ticketId || text.length === 0) {
      return;
    }
    void runMutation(async () => {
      await session.workflow.postTicketMessage({ ticketId, text });
      setCommentText("");
    });
  }, [commentText, runMutation, session, ticketId]);

  if (!environmentId || !boardId || !ticketId) {
    return <LoadingScreen message="Opening ticket…" messagePlacement="above-spinner" />;
  }

  if (!session) {
    // Cold-start notification tap: the saved session may still be (re)connecting.
    // Show "Connecting…" while hydration is in flight; only fall through to the
    // terminal "not connected" EmptyState once hydration has settled.
    if (stillHydrating) {
      return <LoadingScreen message="Connecting…" messagePlacement="above-spinner" />;
    }

    return (
      <ScreenShell>
        <EmptyState
          title="Environment not connected"
          detail={routeConnectionError ?? "Reconnect to this environment to open the ticket."}
        />
      </ScreenShell>
    );
  }

  if (loading) {
    return <LoadingScreen message="Opening ticket…" messagePlacement="above-spinner" />;
  }

  if (loadError || !detail) {
    return (
      <ScreenShell>
        <EmptyState
          title="Ticket unavailable"
          detail={loadError ?? "This ticket could not be loaded."}
        />
      </ScreenShell>
    );
  }

  const affordance = selectTicketAffordance(detail);
  const ticket = detail.ticket;
  const sourceOwned = isTicketSourceOwned(detail);

  return (
    <View className="flex-1 bg-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 20, gap: 16 }}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View className="gap-1">
          <Text className="font-t3-bold text-2xl text-foreground">{ticket.title}</Text>
          <Text className="font-sans text-sm text-foreground-muted">
            {ticket.currentLane?.name ?? ticket.currentLaneKey} · {ticket.status}
          </Text>
          {sourceOwned && detail.syncedSource ? (
            <Pressable
              onPress={() => void Linking.openURL(detail.syncedSource!.url)}
              className="self-start"
            >
              <Text className="font-sans text-xs text-foreground-muted">
                Synced from {detail.syncedSource.provider} ↗
              </Text>
            </Pressable>
          ) : null}
        </View>

        {mutationError ? (
          <View className="rounded-2xl border border-border bg-card p-3">
            <Text className="font-sans text-sm text-danger">{mutationError}</Text>
          </View>
        ) : null}

        {affordance.kind === "answer" ? (
          <View className="gap-3 rounded-[22px] border border-border bg-card p-4">
            <Text className="font-t3-bold text-base text-foreground">
              {affordance.question ?? "The agent needs your input."}
            </Text>
            <TextInput
              className="min-h-[64px] rounded-2xl border border-border bg-screen px-3 py-2 text-foreground"
              multiline
              placeholder="Type your answer…"
              value={answerText}
              editable={!busy}
              onChangeText={setAnswerText}
            />
            <ActionButton
              label="Send"
              disabled={busy || answerText.trim().length === 0}
              onPress={() => onSubmitAnswer(affordance.stepRunId)}
            />
          </View>
        ) : null}

        {affordance.kind === "approve" ? (
          <View className="gap-3 rounded-[22px] border border-border bg-card p-4">
            <Text className="font-t3-bold text-base text-foreground">
              {affordance.question ?? "The agent is waiting for your approval."}
            </Text>
            <View className="flex-row gap-3">
              <ActionButton
                label="Approve"
                disabled={busy}
                onPress={() => onResolveApproval(affordance.stepRunId, true)}
              />
              <ActionButton
                label="Reject"
                tone="danger"
                disabled={busy}
                onPress={() => onResolveApproval(affordance.stepRunId, false)}
              />
            </View>
          </View>
        ) : null}

        {affordance.kind === "blocked" ? (
          <View className="gap-3 rounded-[22px] border border-border bg-card p-4">
            <Text className="font-t3-bold text-base text-foreground">Blocked</Text>
            <Text className="font-sans text-sm text-foreground-muted">
              {affordance.blockReason ?? "This ticket is blocked."}
            </Text>
          </View>
        ) : null}

        {affordance.laneActions.length > 0 ? (
          <View className="gap-2 rounded-[22px] border border-border bg-card p-4">
            <Text className="font-t3-bold text-base text-foreground">Move ticket</Text>
            <View className="flex-row flex-wrap gap-2">
              {affordance.laneActions.map((action) => (
                <ActionButton
                  key={`${action.to}-${action.label}`}
                  label={action.label}
                  tone="secondary"
                  disabled={busy}
                  onPress={() => onMoveTicket(action.to)}
                />
              ))}
            </View>
          </View>
        ) : null}

        <View className="gap-3 rounded-[22px] border border-border bg-card p-4">
          <Text className="font-t3-bold text-base text-foreground">Add a comment</Text>
          <TextInput
            className="min-h-[48px] rounded-2xl border border-border bg-screen px-3 py-2 text-foreground"
            multiline
            placeholder="Leave a note…"
            value={commentText}
            editable={!busy}
            onChangeText={setCommentText}
          />
          <ActionButton
            label="Post"
            disabled={busy || commentText.trim().length === 0}
            onPress={onPostComment}
          />
        </View>

        {detail.messages.length > 0 ? (
          <View className="gap-3">
            <Text className="font-t3-bold text-base text-foreground">Conversation</Text>
            {detail.messages.map((message) => (
              <MessageRow key={message.messageId} message={message} />
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ScreenShell(props: { readonly children: React.ReactNode }) {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: "center",
        paddingHorizontal: 24,
        paddingVertical: 32,
      }}
      className="bg-screen flex-1"
    >
      <Stack.Screen options={{ headerShown: false }} />
      {props.children}
    </ScrollView>
  );
}

function ActionButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly tone?: "primary" | "secondary" | "danger";
}) {
  const tone = props.tone ?? "primary";
  const bg = tone === "danger" ? "bg-danger" : tone === "secondary" ? "bg-card-alt" : "bg-primary";
  const fg = tone === "secondary" ? "text-foreground" : "text-primary-foreground";

  return (
    <Pressable
      className={`rounded-full px-4 py-2.5 active:opacity-70 ${bg} ${
        props.disabled ? "opacity-40" : ""
      }`}
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <Text className={`text-[13px] font-t3-bold ${fg}`}>{props.label}</Text>
    </Pressable>
  );
}

function MessageRow(props: { readonly message: WorkflowTicketMessageView }) {
  const { message } = props;
  return (
    <View className="rounded-2xl border border-border bg-card p-3">
      <Text className="font-t3-bold text-xs uppercase text-foreground-muted">{message.author}</Text>
      <Text className="mt-1 font-sans text-sm text-foreground">{message.body}</Text>
    </View>
  );
}
