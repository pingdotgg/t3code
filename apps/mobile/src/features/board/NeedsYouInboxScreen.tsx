import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EnvironmentId, type WorkflowNeedsAttentionTicketView } from "@t3tools/contracts";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { buildTicketRoutePath } from "../../lib/routes";
import { getEnvironmentClient } from "../../state/environment-session-registry";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { InboxSkeleton } from "./InboxSkeleton";
import { deriveInboxViewState } from "./inboxViewState";

interface NeedsYouRow {
  readonly environmentId: EnvironmentId;
  readonly ticket: WorkflowNeedsAttentionTicketView;
}

function attentionLabel(ticket: WorkflowNeedsAttentionTicketView): string {
  switch (ticket.attentionKind) {
    case "waiting_for_approval":
      return "Needs approval";
    case "waiting_for_input":
      return "Needs input";
    case "blocked":
      return "Blocked";
    default:
      return ticket.status;
  }
}

function formatRelative(updatedAt: string): string {
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) {
    return "";
  }
  const deltaMs = Date.now() - then;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function NeedsYouInboxScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [rows, setRows] = useState<readonly NeedsYouRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [partialError, setPartialError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mountedRef = useRef(true);
  // Monotonic load generation: every load() captures its id at start; only the
  // LATEST-started load may commit rows/error/partialError/loading. Without this,
  // a slow focus-triggered load could resolve after a newer retry and overwrite
  // its result — e.g. stomping a real failure with a stale "all caught up".
  const loadIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const environmentIds = useMemo(
    () => Object.keys(savedConnectionsById).map((id) => EnvironmentId.make(id)),
    [savedConnectionsById],
  );

  const load = useCallback(async () => {
    // Claim a generation synchronously, before the first await. The most recent
    // load() to start owns loadIdRef; any older in-flight load fails isLatest()
    // after its awaits and commits nothing.
    const myLoadId = (loadIdRef.current += 1);
    const isLatest = () => loadIdRef.current === myLoadId && mountedRef.current;

    if (isLatest()) {
      setError(null);
      setPartialError(null);
    }
    const aggregated: NeedsYouRow[] = [];
    const failures: string[] = [];

    await Promise.all(
      environmentIds.map(async (environmentId) => {
        const client = getEnvironmentClient(environmentId);
        if (!client) {
          return;
        }
        try {
          const tickets = await client.workflow.listNeedsAttentionTickets({});
          for (const ticket of tickets) {
            aggregated.push({ environmentId, ticket });
          }
        } catch (cause) {
          failures.push(cause instanceof Error ? cause.message : "Failed to load tickets.");
        }
      }),
    );

    if (!isLatest()) {
      return;
    }

    aggregated.sort((a, b) => {
      // Date.parse yields NaN for malformed timestamps; treat those as oldest so
      // the comparator stays a deterministic total order (NaN subtraction would
      // corrupt the sort across engines).
      const dateA = Date.parse(a.ticket.updatedAt);
      const dateB = Date.parse(b.ticket.updatedAt);
      if (Number.isNaN(dateA) && Number.isNaN(dateB)) return 0;
      if (Number.isNaN(dateA)) return 1;
      if (Number.isNaN(dateB)) return -1;
      return dateB - dateA;
    });
    setRows(aggregated);

    if (aggregated.length === 0 && failures.length > 0) {
      // Full failure: every environment errored (or there were no rows at all).
      setError(failures[0] ?? "Failed to load tickets.");
      setPartialError(null);
    } else if (aggregated.length > 0 && failures.length > 0) {
      // Partial failure: we got some rows but at least one environment failed.
      setError(null);
      setPartialError("Some boards couldn't be loaded — pull to refresh to retry.");
    } else {
      setError(null);
      setPartialError(null);
    }
    setLoading(false);
  }, [environmentIds]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load();
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load().finally(() => {
      if (mountedRef.current) {
        setRefreshing(false);
      }
    });
  }, [load]);

  const triggerLoad = useCallback(() => {
    setRows([]);
    setLoading(true);
    void load();
  }, [load]);

  const viewState = deriveInboxViewState({ loading, refreshing, rows, error, partialError });

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 20, gap: 12, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <Text className="font-t3-bold text-2xl text-foreground">Needs you</Text>

        {/* Skeleton during initial load */}
        {viewState.kind === "skeleton" ? <InboxSkeleton /> : null}

        {/* Full failure: zero rows + error */}
        {viewState.kind === "error" ? (
          <View className="flex-1 justify-center">
            <EmptyState
              title="Couldn't load your inbox"
              detail={viewState.message}
              actionLabel="Try again"
              onAction={triggerLoad}
            />
          </View>
        ) : null}

        {/* True empty: fetch finished cleanly */}
        {viewState.kind === "empty" ? (
          <View className="flex-1 justify-center">
            <EmptyState
              title="You're all caught up"
              detail="No tickets are waiting on you right now."
            />
          </View>
        ) : null}

        {/* List with optional partial-failure banner */}
        {viewState.kind === "list" ? (
          <>
            {viewState.partialErrorMessage !== null ? (
              <ErrorBanner message={viewState.partialErrorMessage} />
            ) : null}

            {rows.map((row) => (
              <Pressable
                key={`${row.environmentId}:${row.ticket.ticketId}`}
                className="gap-1 rounded-[22px] border border-border bg-card p-4 active:opacity-70"
                onPress={() =>
                  router.push(
                    buildTicketRoutePath({
                      environmentId: row.environmentId,
                      boardId: row.ticket.boardId,
                      ticketId: row.ticket.ticketId,
                    }),
                  )
                }
              >
                <View className="flex-row items-center justify-between gap-2">
                  <Text className="flex-1 font-t3-bold text-base text-foreground" numberOfLines={1}>
                    {row.ticket.title}
                  </Text>
                  <Text className="font-sans text-xs text-foreground-muted">
                    {formatRelative(row.ticket.updatedAt)}
                  </Text>
                </View>
                <Text className="font-sans text-sm text-foreground-muted">
                  {row.ticket.boardName}
                </Text>
                <View className="mt-1 self-start rounded-full bg-card-alt px-2.5 py-1">
                  <Text className="font-t3-bold text-xs text-foreground">
                    {attentionLabel(row.ticket)}
                  </Text>
                </View>
              </Pressable>
            ))}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
