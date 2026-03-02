import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrchestrationEvent, OrchestrationReadModel, WsWelcomePayload } from "@t3tools/contracts";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  createBackendProfileId,
  loadBackendState,
  normalizeBackendInput,
  saveBackendProfiles,
  setActiveBackendProfileId,
  type BackendProfile,
} from "./backendProfiles";
import { T3MobileClient } from "./t3MobileClient";
import type { TransportStatus } from "./wsTransport";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
    },
  },
});

type ThemeButtonVariant = "primary" | "ghost" | "danger";

function ThemeButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly variant?: ThemeButtonVariant;
}) {
  const { label, onPress, disabled = false, variant = "primary" } = props;
  const backgroundClassName =
    variant === "primary"
      ? "bg-blue-600"
      : variant === "danger"
        ? "bg-red-600"
        : "bg-slate-200";
  const textClassName = variant === "ghost" ? "text-slate-700" : "text-white";

  return (
    <Pressable
      className={`h-11 items-center justify-center rounded-xl px-4 ${backgroundClassName} ${disabled ? "opacity-50" : "opacity-100"}`}
      disabled={disabled}
      onPress={onPress}
    >
      <Text className={`text-sm font-semibold ${textClassName}`}>{label}</Text>
    </Pressable>
  );
}

function SectionCard(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <View className="gap-3 rounded-2xl border border-slate-200 bg-white p-4">
      <Text className="text-xs font-semibold uppercase tracking-[1.5px] text-slate-500">{props.title}</Text>
      {props.children}
    </View>
  );
}

function statusLabel(status: TransportStatus): string {
  if (status.state === "connected") return "Connected";
  if (status.state === "connecting") return "Connecting";
  if (status.state === "error") return "Connection Error";
  return "Disconnected";
}

function statusClassName(status: TransportStatus): string {
  if (status.state === "connected") return "bg-emerald-100 text-emerald-700";
  if (status.state === "connecting") return "bg-amber-100 text-amber-700";
  if (status.state === "error") return "bg-red-100 text-red-700";
  return "bg-slate-200 text-slate-700";
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "-";

  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "-";
  return value.toLocaleString();
}

function formatEventType(event: OrchestrationEvent): string {
  const eventRecord = event as Record<string, unknown>;
  if (typeof eventRecord.type === "string") return eventRecord.type;
  return "event";
}

function formatEventTimestamp(event: OrchestrationEvent): string {
  const eventRecord = event as Record<string, unknown>;
  if (typeof eventRecord.createdAt === "string") return formatDate(eventRecord.createdAt);
  return "";
}

function eventKey(event: OrchestrationEvent): string {
  const eventRecord = event as Record<string, unknown>;
  if (typeof eventRecord.eventId === "string") return eventRecord.eventId;
  if (typeof eventRecord.id === "string") return eventRecord.id;
  return `${formatEventType(event)}-${formatEventTimestamp(event)}`;
}

function AppContent() {
  const queryClient = useQueryClient();
  const cleanupRef = useRef<(() => void) | null>(null);

  const [profiles, setProfiles] = useState<BackendProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [initialActiveProfileId, setInitialActiveProfileId] = useState<string | null>(null);
  const [loadingProfiles, setLoadingProfiles] = useState(true);

  const [wsUrlInput, setWsUrlInput] = useState("");
  const [authTokenInput, setAuthTokenInput] = useState("");

  const [client, setClient] = useState<T3MobileClient | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<TransportStatus>({
    state: "disconnected",
  });
  const [welcome, setWelcome] = useState<WsWelcomePayload | null>(null);
  const [recentEvents, setRecentEvents] = useState<OrchestrationEvent[]>([]);
  const [uiError, setUiError] = useState<string | null>(null);

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) ?? null,
    [activeProfileId, profiles],
  );

  const snapshotQuery = useQuery<OrchestrationReadModel>({
    queryKey: ["orchestration.snapshot", activeProfileId],
    queryFn: async () => {
      if (!client) {
        throw new Error("No active backend connection.");
      }
      return client.getSnapshot();
    },
    enabled: client !== null && activeProfileId !== null,
    refetchInterval: connectionStatus.state === "connected" ? 10_000 : false,
  });

  const disconnectFromBackend = useCallback(async () => {
    cleanupRef.current?.();
    cleanupRef.current = null;

    setClient(null);
    setActiveProfileId(null);
    setWelcome(null);
    setRecentEvents([]);
    setConnectionStatus({ state: "disconnected" });

    await setActiveBackendProfileId(null);
    queryClient.removeQueries({ queryKey: ["orchestration.snapshot"] });
  }, [queryClient]);

  const connectToProfile = useCallback(
    async (profile: BackendProfile) => {
      setUiError(null);
      cleanupRef.current?.();
      cleanupRef.current = null;

      setWelcome(null);
      setRecentEvents([]);
      setConnectionStatus({ state: "connecting" });

      const nextClient = new T3MobileClient({
        profile,
        onStatus: (status) => {
          setConnectionStatus(status);
        },
      });

      const unsubscribeWelcome = nextClient.onWelcome((payload) => {
        setWelcome(payload);
      });

      const unsubscribeDomainEvents = nextClient.onDomainEvent((event) => {
        setRecentEvents((current) => [event, ...current].slice(0, 60));
        void queryClient.invalidateQueries({ queryKey: ["orchestration.snapshot", profile.id] });
      });

      cleanupRef.current = () => {
        unsubscribeWelcome();
        unsubscribeDomainEvents();
        nextClient.dispose();
      };

      setClient(nextClient);
      setActiveProfileId(profile.id);
      await setActiveBackendProfileId(profile.id);

      const now = new Date().toISOString();
      setProfiles((current) => {
        const nextProfiles = current.map((candidate) =>
          candidate.id === profile.id ? { ...candidate, lastConnectedAt: now } : candidate,
        );
        void saveBackendProfiles(nextProfiles);
        return nextProfiles;
      });

      void queryClient.invalidateQueries({ queryKey: ["orchestration.snapshot", profile.id] });
    },
    [queryClient],
  );

  const saveAndConnectProfile = useCallback(async () => {
    try {
      setUiError(null);
      const normalized = normalizeBackendInput(wsUrlInput, authTokenInput);
      const now = new Date().toISOString();

      const existing = profiles.find(
        (profile) => profile.url === normalized.url && (profile.authToken ?? "") === (normalized.authToken ?? ""),
      );

      const profile: BackendProfile = existing
        ? {
            ...existing,
            name: normalized.name,
          }
        : {
            id: createBackendProfileId(),
            name: normalized.name,
            url: normalized.url,
            authToken: normalized.authToken,
            createdAt: now,
            lastConnectedAt: null,
          };

      const nextProfiles = existing
        ? profiles.map((candidate) => (candidate.id === existing.id ? profile : candidate))
        : [profile, ...profiles];

      setProfiles(nextProfiles);
      await saveBackendProfiles(nextProfiles);
      await connectToProfile(profile);

      setWsUrlInput("");
      setAuthTokenInput("");
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "Unable to save backend profile.");
    }
  }, [authTokenInput, connectToProfile, profiles, wsUrlInput]);

  const removeProfile = useCallback(
    async (profileId: string) => {
      const nextProfiles = profiles.filter((profile) => profile.id !== profileId);
      setProfiles(nextProfiles);
      await saveBackendProfiles(nextProfiles);

      if (activeProfileId === profileId) {
        await disconnectFromBackend();
      }

      if (initialActiveProfileId === profileId) {
        setInitialActiveProfileId(null);
      }
    },
    [activeProfileId, disconnectFromBackend, initialActiveProfileId, profiles],
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const state = await loadBackendState();
      if (cancelled) return;

      setProfiles(state.profiles);
      setInitialActiveProfileId(state.activeProfileId);
      setLoadingProfiles(false);
    })();

    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (loadingProfiles || !initialActiveProfileId) return;

    const profile = profiles.find((candidate) => candidate.id === initialActiveProfileId);
    setInitialActiveProfileId(null);

    if (profile) {
      void connectToProfile(profile);
    }
  }, [connectToProfile, initialActiveProfileId, loadingProfiles, profiles]);

  const snapshotError = snapshotQuery.error instanceof Error ? snapshotQuery.error.message : null;
  const snapshot = snapshotQuery.data;

  if (loadingProfiles) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-slate-100">
        <ActivityIndicator size="small" color="#334155" />
        <Text className="mt-3 text-sm text-slate-600">Loading servers...</Text>
      </SafeAreaView>
    );
  }

  if (client && activeProfile) {
    return (
      <SafeAreaView className="flex-1 bg-slate-100">
        <StatusBar />
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
          <View className="rounded-2xl border border-slate-200 bg-white p-4">
            <View className="flex-row items-start justify-between">
              <View className="max-w-[75%] gap-1">
                <Text className="text-xl font-semibold text-slate-900">T3 Code Mobile</Text>
                <Text className="text-xs text-slate-600">{activeProfile.name}</Text>
                <Text className="text-[11px] text-slate-500">{activeProfile.url}</Text>
              </View>
              <View className={`rounded-full px-3 py-1 ${statusClassName(connectionStatus)}`}>
                <Text className="text-xs font-semibold">{statusLabel(connectionStatus)}</Text>
              </View>
            </View>
            {connectionStatus.detail ? (
              <Text className="mt-3 text-[11px] text-slate-500">{connectionStatus.detail}</Text>
            ) : null}
            <View className="mt-4 flex-row gap-2">
              <View className="flex-1">
                <ThemeButton
                  label={snapshotQuery.isFetching ? "Refreshing..." : "Refresh Snapshot"}
                  onPress={() => {
                    void snapshotQuery.refetch();
                  }}
                  disabled={snapshotQuery.isFetching}
                />
              </View>
              <View className="flex-1">
                <ThemeButton label="Switch Server" variant="ghost" onPress={() => void disconnectFromBackend()} />
              </View>
            </View>
          </View>

          <SectionCard title="Session">
            <Text className="text-sm text-slate-700">Project: {welcome?.projectName ?? "Waiting for welcome event..."}</Text>
            <Text className="text-sm text-slate-700">Workspace: {welcome?.cwd ?? "-"}</Text>
            <Text className="text-sm text-slate-700">
              Bootstrap Thread: {welcome?.bootstrapThreadId ?? "not provided"}
            </Text>
          </SectionCard>

          <SectionCard title="Orchestration Snapshot">
            {snapshotQuery.isLoading ? (
              <View className="items-start gap-2">
                <ActivityIndicator size="small" color="#334155" />
                <Text className="text-sm text-slate-600">Loading snapshot...</Text>
              </View>
            ) : snapshotError ? (
              <Text className="text-sm text-red-700">{snapshotError}</Text>
            ) : snapshot ? (
              <View className="gap-2">
                <Text className="text-sm text-slate-700">Projects: {snapshot.projects.length}</Text>
                <Text className="text-sm text-slate-700">Threads: {snapshot.threads.length}</Text>
                <Text className="text-sm text-slate-700">Updated: {formatDate(snapshot.updatedAt)}</Text>
                <View className="mt-1 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  {snapshot.projects.slice(0, 4).map((project) => (
                    <View key={project.id} className="gap-0.5">
                      <Text className="text-sm font-medium text-slate-800">{project.title}</Text>
                      <Text className="text-[11px] text-slate-500">{project.workspaceRoot}</Text>
                    </View>
                  ))}
                  {snapshot.projects.length === 0 ? (
                    <Text className="text-sm text-slate-500">No projects available.</Text>
                  ) : null}
                </View>
              </View>
            ) : (
              <Text className="text-sm text-slate-600">No snapshot data available.</Text>
            )}
          </SectionCard>

          <SectionCard title="Recent Domain Events">
            {recentEvents.length === 0 ? (
              <Text className="text-sm text-slate-500">No events received yet.</Text>
            ) : (
              <View className="gap-2">
                {recentEvents.slice(0, 25).map((event) => (
                  <View
                    key={eventKey(event)}
                    className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                  >
                    <Text className="text-xs font-semibold uppercase text-slate-700">{formatEventType(event)}</Text>
                    <Text className="mt-1 text-[11px] text-slate-500">{formatEventTimestamp(event)}</Text>
                  </View>
                ))}
              </View>
            )}
          </SectionCard>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-slate-100">
      <StatusBar />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
        <View className="rounded-2xl border border-slate-200 bg-white p-4">
          <Text className="text-2xl font-semibold text-slate-900">Connect T3 Code</Text>
          <Text className="mt-2 text-sm leading-5 text-slate-600">
            Enter your websocket server URL and optional auth token. Saved servers appear below.
          </Text>

          <View className="mt-4 gap-3">
            <View className="gap-1.5">
              <Text className="text-xs font-semibold uppercase tracking-[1.4px] text-slate-500">Server URL</Text>
              <TextInput
                className="h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="ws://localhost:3773"
                placeholderTextColor="#94a3b8"
                value={wsUrlInput}
                onChangeText={setWsUrlInput}
              />
            </View>
            <View className="gap-1.5">
              <Text className="text-xs font-semibold uppercase tracking-[1.4px] text-slate-500">Auth Token (Optional)</Text>
              <TextInput
                className="h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="token"
                placeholderTextColor="#94a3b8"
                value={authTokenInput}
                onChangeText={setAuthTokenInput}
              />
            </View>
            <ThemeButton label="Save and Connect" onPress={() => void saveAndConnectProfile()} />
          </View>
          {uiError ? <Text className="mt-3 text-sm text-red-700">{uiError}</Text> : null}
        </View>

        <SectionCard title="Saved Backends">
          {profiles.length === 0 ? (
            <Text className="text-sm text-slate-500">No servers saved yet.</Text>
          ) : (
            <View className="gap-3">
              {profiles.map((profile) => (
                <View key={profile.id} className="gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <View className="gap-1">
                    <Text className="text-sm font-semibold text-slate-900">{profile.name}</Text>
                    <Text className="text-[11px] text-slate-600">{profile.url}</Text>
                    <Text className="text-[11px] text-slate-500">
                      Token: {profile.authToken ? "configured" : "none"}
                    </Text>
                    <Text className="text-[11px] text-slate-500">
                      Last connected: {formatDate(profile.lastConnectedAt)}
                    </Text>
                  </View>
                  <View className="flex-row gap-2">
                    <View className="flex-1">
                      <ThemeButton
                        label="Connect"
                        onPress={() => {
                          void connectToProfile(profile);
                        }}
                      />
                    </View>
                    <View className="flex-1">
                      <ThemeButton
                        label="Delete"
                        variant="danger"
                        onPress={() => {
                          void removeProfile(profile.id);
                        }}
                      />
                    </View>
                  </View>
                </View>
              ))}
            </View>
          )}
        </SectionCard>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  );
}
