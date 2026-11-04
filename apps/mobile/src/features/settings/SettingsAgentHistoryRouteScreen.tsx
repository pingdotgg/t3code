import { continueAgentSession } from "@t3tools/client-runtime/state/agent-sessions";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  ProjectId,
  type AgentSessionHistoryResult,
  type AgentSessionPreviewInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, View, type TextInputInstance } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { SearchField } from "../../components/ui/SearchField";
import { uuidv4 } from "../../lib/uuid";
import { agentSessions } from "../../state/agent-sessions";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectedThreadProjection } from "../../state/use-thread-detail";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { SettingsScreen } from "./components/SettingsScreen";

type Session = AgentSessionHistoryResult["sessions"][number];

export function SettingsAgentHistoryRouteScreen() {
  const { environments } = useEnvironments();
  const current = useSelectedThreadProjection();
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const environment =
    environments.find((entry) => entry.environmentId === selectedId) ??
    environments.find((entry) => entry.environmentId === current?.environmentId) ??
    environments[0];
  const environmentPicker = (
    <View className="items-start">
      <Menu
        actions={environments.map((entry) => ({ id: entry.environmentId, title: entry.label }))}
        onPressAction={({ nativeEvent }) => {
          const selected = environments.find((entry) => entry.environmentId === nativeEvent.event);
          if (selected) setSelectedId(selected.environmentId);
        }}
      >
        <Button label={environment?.label ?? "Choose a computer"} onPress={() => {}} />
      </Menu>
    </View>
  );
  return (
    <SettingsScreen title="Agent history">
      {environment ? (
        <HistoryBrowser
          key={environment.environmentId}
          environment={environment}
          environmentPicker={environmentPicker}
          initialProjectId={
            environment.environmentId === current?.environmentId
              ? current.projection.thread.projectId
              : undefined
          }
        />
      ) : (
        <ScreenScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-4 px-5 pb-8"
        >
          {environmentPicker}
          <Text className="text-foreground-muted">Connect a computer to browse its history.</Text>
        </ScreenScrollView>
      )}
    </SettingsScreen>
  );
}

function HistoryBrowser({
  environment,
  environmentPicker,
  initialProjectId,
}: {
  environment: EnvironmentPresentation;
  environmentPicker: ReactNode;
  initialProjectId: ProjectId | undefined;
}) {
  const { environmentId } = environment;
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  const [chosenProject, setProjectId] = useState<string | null>(initialProjectId ?? null);
  const projectId = chosenProject ?? projects[0]?.id ?? "all";
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<AgentSessionHistoryResult["nextCursor"]>(null);
  const [selected, setSelected] = useState<Session | null>(null);
  const inputRef = useRef<TextInputInstance>(null);
  const registry = useContext(RegistryContext);
  const project = projects.find((entry) => entry.id === projectId);
  const atom = agentSessions.history({
    environmentId,
    input: {
      query,
      ...(project ? { workspaceRoot: project.workspaceRoot } : {}),
      ...(cursor ? { cursor } : {}),
    },
  });
  const result = useAtomValue(atom);
  const data = AsyncResult.getOrElse(result, () => null);
  const connected = environment.connection.phase === "connected";
  if (selected)
    return (
      <HistoryDetail
        key={`${selected.providerInstanceId}:${selected.providerSessionId}`}
        environment={environment}
        environmentPicker={environmentPicker}
        session={selected}
        onBack={() => setSelected(null)}
      />
    );
  return (
    <ScreenScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-4 px-5 pb-8"
    >
      {environmentPicker}
      <Text className="text-sm text-foreground-muted">
        Find a conversation. Pick up where you left off.
      </Text>
      <SearchField
        inputRef={inputRef}
        autoFocus={false}
        accessibilityLabel="Search sessions"
        clearAccessibilityLabel="Clear search"
        placeholder="Search titles, projects and cached context"
        value={query}
        onChangeText={(value) => {
          setQuery(value.slice(0, 200));
          setCursor(null);
        }}
      />
      <View className="flex-row flex-wrap gap-2">
        <Menu
          actions={[
            { id: "all", title: "All projects" },
            ...projects.map((entry) => ({ id: entry.id, title: entry.title })),
          ]}
          onPressAction={({ nativeEvent }) => {
            setProjectId(nativeEvent.event);
            setCursor(null);
          }}
        >
          <Button label={project?.title ?? "All projects"} onPress={() => {}} />
        </Menu>
        <Button
          label="Refresh"
          tone="text"
          disabled={!connected || result.waiting}
          onPress={() => registry.refresh(atom)}
        />
      </View>
      {!connected && (
        <Text className="text-sm text-foreground-muted">
          Offline · Cached history is read-only. Reconnect {environment.label} to continue.
        </Text>
      )}
      {result._tag === "Failure" && (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          Could not read history. Reconnect and refresh to try again.
        </Text>
      )}
      {data && (
        <Text className="text-xs text-foreground-muted">
          Checked {new Date(data.scannedAt).toLocaleString()}
        </Text>
      )}
      {result._tag === "Initial" && <Text>Reading session metadata…</Text>}
      {data?.sessions.length === 0 && !data.nextCursor && (
        <Text className="text-foreground-muted">No conversations found in this scope.</Text>
      )}
      {data?.sessions.map((session) => (
        <Pressable
          key={`${session.providerInstanceId}:${session.providerSessionId}`}
          accessibilityRole="button"
          onPress={() => setSelected(session)}
          className="gap-2 rounded-xl bg-card p-4 active:bg-primary/20"
        >
          <Text className="font-t3-medium">{session.title}</Text>
          {(session.recap?.summary ?? session.recentExcerpt) && (
            <Text numberOfLines={2} className="text-sm text-foreground-muted">
              {session.recap?.summary ?? session.recentExcerpt}
            </Text>
          )}
          <Text numberOfLines={1} className="text-xs text-foreground-muted">
            {session.workspaceRoot}
          </Text>
          <View className="flex-row justify-between">
            <Text className="text-xs text-foreground-muted">
              {session.provider === "claudeAgent"
                ? "Claude"
                : session.provider === "codex"
                  ? "Codex"
                  : "Pi"}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {new Date(session.updatedAt).toLocaleDateString()}
            </Text>
          </View>
        </Pressable>
      ))}
      <View className="flex-row gap-2">
        {cursor && <Button label="Newest" tone="text" onPress={() => setCursor(null)} />}
        {data?.nextCursor && (
          <Button
            label={data.truncated ? "Continue discovery" : "Older sessions"}
            onPress={() => setCursor(data.nextCursor)}
          />
        )}
      </View>
      {data?.truncated && (
        <Text className="text-xs text-foreground-muted">
          Discovery is still in progress. Continue to find sessions beyond this scan.
        </Text>
      )}
    </ScreenScrollView>
  );
}

function HistoryDetail({
  environment,
  environmentPicker,
  session,
  onBack,
}: {
  environment: EnvironmentPresentation;
  environmentPicker: ReactNode;
  session: Session;
  onBack: () => void;
}) {
  const { environmentId } = environment;
  const input = {
    workspaceRoot: session.workspaceRoot,
    session: {
      providerInstanceId: session.providerInstanceId,
      providerSessionId: session.providerSessionId,
    },
  };
  const result = useAtomValue(agentSessions.preview({ environmentId, input }));
  const preview = AsyncResult.getOrElse(result, () => null);
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  const canImport = useAtomValue(agentSessions.importSession.permissionAtom(environmentId));
  const importSession = useAtomCommand(agentSessions.importSession);
  const generateRecap = useAtomCommand(agentSessions.generateRecap);
  const canRecap = useAtomValue(agentSessions.generateRecap.permissionAtom(environmentId));
  const registry = useContext(RegistryContext);
  const [recapping, setRecapping] = useState(false);
  const createProject = useAtomCommand(projectEnvironment.create);
  const selectDetail = useSelectWorkspaceDetail();
  const [showMessages, setShowMessages] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Ignore an async import result after its selected conversation unmounts.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const requestRecap = async () => {
    setRecapping(true);
    setError(null);
    const generated = await generateRecap({ environmentId, input });
    if (!mounted.current) return;
    setRecapping(false);
    if (generated._tag !== "Success" || generated.value.status !== "ready") {
      setError("Could not generate a recap. The conversation may have changed; try again.");
      return;
    }
    registry.refresh(agentSessions.preview({ environmentId, input }));
  };
  const continueSession = async () => {
    setPending(true);
    setError(null);
    const continued = await continueAgentSession({
      environmentId,
      workspaceRoot: session.workspaceRoot,
      session: input.session,
      projects,
      newProjectId: () => ProjectId.make(uuidv4()),
      isMounted: () => mounted.current,
      createProject,
      importSession,
    });
    if (!mounted.current || continued.status === "cancelled") return;
    setPending(false);
    if (continued.status === "project-error") {
      setError("Restore the original project folder and try again.");
      return;
    }
    if (continued.status === "import-error") {
      setError("Could not open this session. Refresh history and try again.");
      return;
    }
    selectDetail({ name: "Thread", params: { environmentId, threadId: continued.threadId } });
  };
  return (
    <ScreenScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-5 px-5 pb-8"
    >
      {environmentPicker}
      {environment.connection.phase !== "connected" && (
        <Text className="text-sm text-foreground-muted">
          Offline · Cached history is read-only. Reconnect {environment.label} to continue.
        </Text>
      )}
      <Button label="Back to history" icon="chevron.left" tone="text" onPress={onBack} />
      <View className="gap-2">
        <Text className="text-xl font-t3-medium">
          {preview?.status === "ready" ? preview.title : session.title}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {session.providerInstanceId} · {new Date(session.updatedAt).toLocaleString()}
        </Text>
      </View>
      <View className="gap-3">
        <Text className="font-t3-medium">Recent context</Text>
        {preview?.status === "ready" && preview.recap ? (
          <>
            <Text>{preview.recap.summary}</Text>
            {preview.recap.nextAction && <Text>Next: {preview.recap.nextAction}</Text>}
            <Text className="text-xs text-foreground-muted">
              Generated from the recent message excerpts.
            </Text>
          </>
        ) : preview?.status === "ready" ? (
          preview.messages.slice(-2).map((message) => (
            <Text key={message.id} className="text-base leading-6">
              {message.role === "user" ? "You" : "Agent"}: {message.text.slice(0, 500)}
              {message.text.length > 500 || message.truncated ? "…" : ""}
            </Text>
          ))
        ) : (
          <Text className="text-foreground-muted">
            {preview === null
              ? result._tag === "Failure"
                ? "Preview unavailable. Reconnect to read messages."
                : "Reading recent context…"
              : "Preview unavailable. You can still open a supported native session."}
          </Text>
        )}
        <Button
          label={showMessages ? "Close messages" : "Recent messages"}
          tone="text"
          onPress={() => setShowMessages(!showMessages)}
        />
        {showMessages && (
          <RecentMessages
            environmentId={environmentId}
            input={input}
            connected={environment.connection.phase === "connected"}
          />
        )}
      </View>
      {preview?.status === "ready" && !preview.recap && (
        <View className="gap-2">
          <Button
            label="Generate a short recap"
            loading={recapping}
            disabled={!canRecap || environment.connection.phase !== "connected"}
            onPress={() => void requestRecap()}
          />
          <Text className="text-xs text-foreground-muted">
            Uses your configured text-generation model.
          </Text>
        </View>
      )}
      <View className="gap-3 border-t border-border pt-5">
        <Text className="font-t3-medium">Continue on {environment.label}</Text>
        <Text className="text-xs text-foreground-muted">{session.workspaceRoot}</Text>
        <Text className="text-sm text-foreground-muted">
          Original profile: {session.providerInstanceId}. Provider and model can be changed in the
          thread composer.
        </Text>
      </View>
      <Text className="text-sm text-foreground-muted">
        Activity unknown. Confirm that the external CLI has stopped before continuing.
      </Text>
      <Button
        label={confirmed ? "CLI confirmed stopped" : "The CLI is stopped"}
        tone="secondary"
        onPress={() => setConfirmed(!confirmed)}
      />
      <Button
        label="Continue in T3"
        tone="primary"
        fullWidth
        loading={pending}
        disabled={!confirmed || !canImport || environment.connection.phase !== "connected"}
        onPress={() => void continueSession()}
      />
      <Text className="text-xs text-foreground-muted">
        Opens for review. The agent resumes only when you send a message.
      </Text>
      {error && (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      )}
    </ScreenScrollView>
  );
}

function RecentMessages({
  environmentId,
  input,
  connected,
}: {
  environmentId: EnvironmentId;
  input: AgentSessionPreviewInput;
  connected: boolean;
}) {
  const [cursor, setCursor] = useState<AgentSessionPreviewInput["cursor"]>(undefined);
  const result = useAtomValue(
    (connected ? agentSessions.livePreview : agentSessions.preview)({
      environmentId,
      input: { ...input, ...(cursor ? { cursor } : {}) },
    }),
  );
  const preview = AsyncResult.getOrElse(result, () => null);
  return (
    <View className="gap-4 rounded-xl bg-card p-4">
      {preview?.status === "ready" ? (
        <>
          {preview.messages.length === 0 && preview.nextCursor?.scan && (
            <Text className="text-foreground-muted">
              This history needs another reading step before its messages are ready.
            </Text>
          )}
          {preview.messages.map((message) => (
            <View key={message.id} className="gap-1">
              <Text className="text-xs text-foreground-muted">
                {message.role === "user" ? "You" : "Agent"}
                {message.truncated ? " · Partial message" : ""}
              </Text>
              <Text className="leading-6">{message.text}</Text>
            </View>
          ))}
          {preview.boundedWindow && (
            <Text className="text-xs text-foreground-muted">
              History loads a few messages at a time. Native continuation uses the original session.
            </Text>
          )}
          {preview.nextCursor && (
            <Button
              label={
                preview.nextCursor.scan && preview.messages.length === 0
                  ? "Continue reading history"
                  : preview.nextCursor.textBefore === undefined
                    ? "Load older"
                    : "Load earlier text"
              }
              onPress={() => setCursor(preview.nextCursor ?? undefined)}
            />
          )}
        </>
      ) : (
        <Text className="text-foreground-muted">
          {preview === null
            ? result._tag === "Failure"
              ? "No cached preview is available. Reconnect to read messages."
              : "Reading messages…"
            : preview.reason === "changed"
              ? "The transcript changed. Return to recent messages to refresh."
              : "Preview unavailable. Return to recent messages to try again."}
        </Text>
      )}
      {cursor && <Button label="Back to recent" tone="text" onPress={() => setCursor(undefined)} />}
    </View>
  );
}
