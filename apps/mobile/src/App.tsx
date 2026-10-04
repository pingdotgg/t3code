import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, KeyboardAvoidingView, Linking, PermissionsAndroid, Platform, Pressable, ScrollView, StatusBar, Switch, View, useColorScheme, type ScrollViewInstance } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useFonts } from "expo-font";
import { DMSans_400Regular } from "@expo-google-fonts/dm-sans/400Regular";
import { DMSans_500Medium } from "@expo-google-fonts/dm-sans/500Medium";
import { DMSans_700Bold } from "@expo-google-fonts/dm-sans/700Bold";
import { Uniwind } from "uniwind";
import type { RuntimeStatus, Session } from "../../../packages/protocol/src/index.ts";
import { RuntimeClient, type ConnectionState } from "./runtime/client";
import { AppText as Text, AppTextInput } from "./components/AppText";
import { EmptyState } from "./components/EmptyState";
import { ErrorBanner } from "./components/ErrorBanner";
import { StatusPill } from "./components/StatusPill";
import { RequestActionButton } from "./components/RequestActionButton";
import { ApprovalCard } from "./components/ApprovalCard";
import { QuestionCard } from "./components/QuestionCard";
import { ChatMarkdown } from "./components/ChatMarkdown";
import { ChangesView } from "./components/ChangesView";
import { TerminalOutput } from "./components/TerminalOutput";
import { localRuntime, type LocalRuntimeState } from "../modules/t3-runtime";
import "../global.css";

export default function App() {
  const [fonts] = useFonts({ "DMSans-Regular": DMSans_400Regular, "DMSans-Medium": DMSans_500Medium, "DMSans-Bold": DMSans_700Bold });
  const scheme = useColorScheme();
  useEffect(() => { Uniwind.setTheme(scheme === "dark" ? "dark" : "light"); }, [scheme]);
  if (!fonts) return null;
  return <SafeAreaProvider><StatusBar barStyle={scheme === "dark" ? "light-content" : "dark-content"} /><MobileApp /></SafeAreaProvider>;
}

function MobileApp() {
  const [runtime, setRuntime] = useState<LocalRuntimeState>({ phase: "stopped", message: "", connection: null, login: { running: false, text: "" } });
  const [connection, setConnection] = useState<ConnectionState>("disconnected");
  const [configured, setConfigured] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [cwd, setCwd] = useState("");
  const [fullAccess, setFullAccess] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"chat" | "changes" | "output">("chat");
  const client = useRef<RuntimeClient | null>(null);
  const paired = useRef("");
  const signingIn = useRef(false);
  const scroll = useRef<ScrollViewInstance>(null);
  const follow = useRef(true);
  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  const connected = connection === "connected";

  const connect = (nextUrl: string, nextToken: string) => {
    try {
      client.current?.disconnect();
      setError(null); setStatus(null);
      const instance = new RuntimeClient({ url: nextUrl, token: nextToken,
        socket: (address, protocols) => new WebSocket(address, protocols),
        onState: (state) => {
          setConnection(state);
          if (state === "connected") {
            void instance.request({ method: "status" }).then((value) => setStatus(value as RuntimeStatus)).catch((e: unknown) => setError(String(e)));
          }
        },
        onMessage: (message) => {
          if ("event" in message && message.event === "snapshot") setSessions(message.sessions);
          else if ("event" in message && message.event === "session") setSessions((previous) => {
            const found = previous.some((s) => s.id === message.session.id);
            return found ? previous.map((s) => s.id === message.session.id ? message.session : s) : [...previous, message.session];
          });
          else if ("event" in message && message.event === "runtime/error") setError(message.message);
        },
      });
      client.current = instance; setConfigured(true); instance.connect();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const receiveRuntime = (state: LocalRuntimeState) => {
    setRuntime(state);
    if (state.phase === "ready" && state.connection) {
      const identity = state.connection.url + state.connection.token;
      if (paired.current !== identity) {
        paired.current = identity; setCwd((previous) => previous || state.connection!.project);
        connect(state.connection.url, state.connection.token);
      }
      if (signingIn.current && !state.login.running) {
        void client.current?.request({ method: "status" }).then((value) => setStatus(value as RuntimeStatus)).catch((e: unknown) => setError(String(e)));
      }
    } else {
      paired.current = ""; client.current?.disconnect(); setConfigured(false);
    }
    signingIn.current = state.login.running;
  };
  const startRuntime = async () => {
    setError(null);
    try {
      if (Platform.OS === "android" && Number(Platform.Version) >= 33) await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      return await localRuntime.start();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return null; }
  };
  useEffect(() => {
    let active = true;
    const native = localRuntime.addListener("onState", (state) => { if (active) receiveRuntime(state); });
    void startRuntime().then((state) => { if (active && state) receiveRuntime(state); });
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        client.current?.connect();
        void client.current?.request({ method: "status" }).then((value) => { if (active) setStatus(value as RuntimeStatus); }).catch(() => {});
      }
    });
    return () => { active = false; native.remove(); subscription.remove(); client.current?.disconnect(); };
  }, []);

  const perform = async (operation: () => Promise<unknown>) => {
    setError(null);
    try { await operation(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const send = async () => {
    if (!selected || !client.current || !prompt.trim() || busy) return;
    const draft = prompt;
    setBusy(true);
    await perform(async () => {
      await client.current!.request({ method: "turn/start", params: { sessionId: selected.id, text: draft } });
      setPrompt((current) => current === draft ? "" : current);
    });
    setBusy(false);
  };

  return <SafeAreaView className="flex-1 bg-screen" edges={["top", "bottom"]}>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <View className="flex-row items-center justify-between border-b border-border px-4 py-3">
        <Pressable accessibilityRole="button" onPress={() => setSelectedId(null)}><Text className="font-t3-bold text-xl">{selected?.title ?? "T3 Mobile"}</Text></Pressable>
        <StatusPill label={connected ? "On this phone" : connection} pillClassName="bg-subtle" textClassName="text-foreground-muted" size="compact" />
      </View>
      {error ? <View className="px-4 pt-3"><ErrorBanner message={error} /></View> : null}
      {!configured ? <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }} keyboardShouldPersistTaps="handled">
        <EmptyState title="Codex on your phone" detail="Your coding environment and Codex are included. No separate terminal app is needed." />
        {runtime.phase === "installing" || runtime.phase === "starting" ? <ActivityIndicator accessibilityLabel="Preparing Codex" /> : null}
        <Text>{runtime.message}</Text>
        <RequestActionButton label={runtime.phase === "error" ? "Retry setup" : "Start Codex"} disabled={runtime.phase === "installing" || runtime.phase === "starting" || runtime.phase === "stopping"} onPress={() => { void startRuntime().then((state) => { if (state) receiveRuntime(state); }); }} />
      </ScrollView> : !selected ? <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
        {!connected ? <EmptyState title="Reconnecting" detail="Restoring your local coding sessions." actionLabel="Reconnect" onAction={() => client.current?.connect()} /> : null}
        {status ? <Text className="text-sm text-foreground-muted">{status.codexAvailable ? status.version : status.error}</Text> : null}
        {status?.codexAvailable && !status.codexAuthenticated ? <View className="gap-3 rounded-[22px] border border-border bg-card p-4">
          <Text className="font-t3-bold text-lg">Sign in to Codex</Text>
          <Text className="text-sm">Get a sign-in code, open the sign-in page, and enter the code shown below.</Text>
          <RequestActionButton label={runtime.login.running ? "Waiting for sign-in…" : "Get sign-in code"} disabled={runtime.login.running} onPress={() => { void perform(() => localRuntime.signIn()); }} />
          {runtime.login.text ? <Text selectable className="text-sm">{runtime.login.text}</Text> : null}
          {runtime.login.running ? <RequestActionButton label="Open sign-in page" onPress={() => { void perform(() => Linking.openURL("https://auth.openai.com/codex/device")); }} /> : null}
        </View> : null}
        {sessions.map((session) => <Pressable accessibilityRole="button" key={session.id} className="gap-1 rounded-[20px] border border-border bg-card p-4" onPress={() => { setSelectedId(session.id); setTab("chat"); setPrompt(""); follow.current = true; }}>
          <Text className="font-t3-bold text-lg">{session.title}</Text><Text className="text-xs text-foreground-muted">{session.cwd} · {session.status}</Text>
        </Pressable>)}
        <View className="gap-3 rounded-[22px] border border-border bg-card p-4">
          <Text className="font-t3-bold text-lg">New Codex session</Text>
          <AppTextInput accessibilityLabel="Project directory" placeholder="Project directory" value={cwd} onChangeText={setCwd} autoCapitalize="none" autoCorrect={false} />
          <View className="flex-row items-center gap-3"><Switch accessibilityLabel="Enable full access" value={fullAccess} onValueChange={setFullAccess} /><Text className="flex-1 text-sm">Full access: allow file writes and commands without OS sandboxing</Text></View>
          <Text className="text-xs text-foreground-muted">{fullAccess ? "Only enable for a project you trust. Codex still requests approval for untrusted commands." : "Read-only by default. Android sandbox support depends on your Codex build."}</Text>
          <RequestActionButton label="Create session" disabled={!connected || busy || !cwd.trim() || status?.codexAvailable !== true || !status.codexAuthenticated} onPress={() => {
            setBusy(true); void perform(async () => {
              const session = await client.current!.request({ method: "session/create", params: { cwd: cwd.trim(), fullAccess } }) as Session;
              setSelectedId(session.id);
            }).finally(() => setBusy(false));
          }} />
        </View>
        <RequestActionButton label="Stop local runtime" tone="secondary" onPress={() => { void perform(() => localRuntime.stop()); }} />
      </ScrollView> : <>
        <View className="flex-row gap-2 px-4 py-3">
          {(["chat", "changes", "output"] as const).map((value) => <RequestActionButton key={value} label={value === "chat" ? "Chat" : value === "changes" ? "Changes" : "Output"} tone={tab === value ? "primary" : "secondary"} onPress={() => setTab(value)} />)}
        </View>
        <ScrollView ref={scroll} contentContainerStyle={{ padding: 16, gap: 16 }} keyboardShouldPersistTaps="handled"
          onScroll={(event) => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; follow.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80; }}
          scrollEventThrottle={100} onContentSizeChange={() => { if (follow.current && tab === "chat") scroll.current?.scrollToEnd({ animated: false }); }}>
          {tab === "chat" ? <>
            {selected.messages.length === 0 ? <EmptyState variant="plain" title="What are we building?" detail="Ask Codex to explore this project or work on a change." /> : null}
            {selected.messages.map((message) => <View key={message.id} className={message.role === "user" ? "self-end rounded-[20px] bg-subtle px-4 py-3" : "gap-2"}>
              {message.role === "assistant" ? <Text className="font-t3-bold text-xs text-foreground-muted">Codex</Text> : null}
              <ChatMarkdown markdown={message.text} />
            </View>)}
            {selected.approvals.map((approval) => <ApprovalCard key={String(approval.id)} approval={approval} connected={connected} onRespond={(decision) => perform(() => client.current!.request({ method: "approval/respond", params: { sessionId: selected.id, requestId: approval.id, decision } }))} />)}
            {selected.questions.map((request) => <QuestionCard key={String(request.id)} request={request} connected={connected} onRespond={(answers) => perform(() => client.current!.request({ method: "question/respond", params: { sessionId: selected.id, requestId: request.id, answers } }))} />)}
          </> : tab === "changes" ? <ChangesView diff={selected.diff} />
            : selected.tools.length ? selected.tools.map((tool) => <View key={tool.id} className="gap-2"><Text selectable className="font-t3-bold text-sm">{tool.title} · {tool.status}</Text>{tool.output ? <TerminalOutput id={tool.id} output={tool.output} /> : null}</View>)
              : <EmptyState variant="plain" title="Command output" detail="Commands run by Codex will appear here." />}
          {selected.error ? <ErrorBanner message={selected.error} /> : null}
        </ScrollView>
        {!connected ? <View className="px-4 pb-2"><RequestActionButton label="Reconnect" tone="secondary" onPress={() => client.current?.connect()} /></View> : null}
        <View className="gap-2 border-t border-border bg-screen px-4 py-3">
          <Text className="text-xs text-foreground-muted">{selected.status === "running" ? "Codex is working…" : selected.status} · {selected.fullAccess ? "full access" : "read-only"}</Text>
          <AppTextInput accessibilityLabel="Message Codex" placeholder="Ask Codex…" multiline value={prompt} onChangeText={setPrompt} editable={connected && selected.status !== "running"} style={{ maxHeight: 140 }} />
          <RequestActionButton label={selected.status === "running" ? "Stop" : "Send"} disabled={!connected || busy || (selected.status === "running" ? !selected.turnId : !prompt.trim())}
            onPress={() => { if (selected.status === "running") void perform(() => client.current!.request({ method: "turn/interrupt", params: { sessionId: selected.id } })); else void send(); }} />
        </View>
      </>}
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
