import * as Dialog from "../../components/ui/Dialog";
import {
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  DEFAULT_TERMINAL_ID,
  EnvironmentId,
  ThreadId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import { type KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppBar } from "../../components/ui/AppBar";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useAtomMount } from "@effect/atom-react";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";
import { TerminalContextSheet } from "./TerminalContextSheet";
import { hasNativeTerminalSurface, supportsNativeTerminalOutput } from "./nativeTerminalModule";
import * as Clipboard from "expo-clipboard";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import {
  KeyboardController,
  KeyboardEvents,
  KeyboardStickyView,
  useKeyboardState,
} from "react-native-keyboard-controller";

import {
  ComposerToolbarButton,
  ComposerToolbarRow,
  ComposerToolbarScroller,
} from "../../components/ComposerToolbar";
import { EmptyState } from "../../components/ui/EmptyState";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { LoadingScreen } from "../../components/LoadingScreen";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentPresentation } from "../../state/presentation";
import { terminalEnvironment } from "../../state/terminal";
import { environmentSession, readEnvironmentScope } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { useServerConfigs } from "../../state/entities";
import { useConnectionsReady } from "../../state/workspace";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STEP,
  stepTerminalFontSize,
} from "../../lib/appearancePreferences";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  useAttachedTerminalSession,
  useKnownTerminalSessions,
} from "../../state/use-terminal-session";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadProjection } from "../../state/use-thread-detail";
import { EnvironmentConnectionNotice } from "../connection/EnvironmentConnectionNotice";
import { TerminalSurface, type TerminalSurfaceHandle } from "./NativeTerminalSurface";
import { getMobileTerminalTheme } from "./terminalTheme";
import { useTerminalExitNavigation } from "./useTerminalExitNavigation";
import {
  useInitialTerminalLaunchLocation,
  takePendingTerminalLaunch,
  type PendingTerminalLaunch,
} from "./terminalLaunchContext";
import {
  basename,
  buildTerminalMenuSessions,
  getTerminalStatusLabel,
  nextOpenTerminalId,
  previousLiveTerminalId,
  resolveTerminalSessionLabel,
  type TerminalMenuSession,
} from "./terminalMenu";
import {
  hostPlatformFromOs,
  resolveModifiedTerminalInput,
  type HostPlatform,
  type PendingModifier,
} from "./terminalInput";
import { createTerminalPasteSession } from "./terminalPaste";
import { cacheTerminalGridSize, getCachedTerminalGridSize } from "./terminalUiState";

function TerminalHeader(props: {
  readonly subtitle: string;
  readonly isEnvironmentReady: boolean;
  readonly canOperateTerminal: boolean;
  readonly fontSize: number;
  readonly terminalId: string;
  readonly sessions: ReadonlyArray<TerminalMenuSession>;
  readonly status: Parameters<typeof getTerminalStatusLabel>[0];
  readonly workspaceRoot: string;
  readonly onCloseTerminal: () => void;
  readonly onDecreaseFontSize: () => void;
  readonly onIncreaseFontSize: () => void;
  readonly onOpenNewTerminal: () => void;
  readonly onSelectTerminal: (terminalId: string) => void;
}) {
  return (
    <AppBar
      title="Terminal"
      subtitle={props.subtitle}
      onBack={props.onCloseTerminal}
      backInSplitView={{
        accessibilityLabel: "Back to chat",
        icon: "chevron.left",
      }}
      menus={
        props.isEnvironmentReady
          ? [
              {
                title: "Terminal options",
                icon: "terminal",
                status: getTerminalStatusLabel(props.status),
                items: [
                  {
                    id: "text-size",
                    title: "Text size",
                    icon: "textformat.size",
                    inline: true,
                    items: [
                      {
                        id: "font-decrease",
                        title: `A- ${Math.max(MIN_TERMINAL_FONT_SIZE, props.fontSize - TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`,
                        disabled: props.fontSize <= MIN_TERMINAL_FONT_SIZE,
                        onPress: props.onDecreaseFontSize,
                      },
                      {
                        id: "font-increase",
                        title: `A+ ${Math.min(MAX_TERMINAL_FONT_SIZE, props.fontSize + TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`,
                        disabled: props.fontSize >= MAX_TERMINAL_FONT_SIZE,
                        onPress: props.onIncreaseFontSize,
                      },
                    ],
                  },
                  ...props.sessions.map((session) => ({
                    id: `terminal-session:${session.terminalId}`,
                    title: session.displayLabel,
                    icon: "terminal",
                    subtitle: [
                      getTerminalStatusLabel({
                        status: session.status,
                        hasRunningSubprocess: session.hasRunningSubprocess,
                      }),
                      basename(session.cwd),
                    ]
                      .filter(Boolean)
                      .join(" · "),
                    selected: session.terminalId === props.terminalId,
                    onPress: () => props.onSelectTerminal(session.terminalId),
                  })),
                  {
                    id: "terminal-new",
                    disabled: !props.canOperateTerminal,
                    title: "Open new terminal",
                    icon: "plus",
                    subtitle: `Start another shell in ${basename(props.workspaceRoot) ?? "this workspace"}`,
                    onPress: props.onOpenNewTerminal,
                  },
                ],
              },
            ]
          : undefined
      }
    />
  );
}

const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const TERMINAL_ACCESSORY_HEIGHT = 52;
const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";

class TerminalClipboardReadError extends Schema.TaggedError<TerminalClipboardReadError>()(
  "TerminalClipboardReadError",
  { terminalId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to read the clipboard for a paste into terminal ${this.terminalId}.`;
  }
}

type TerminalToolbarAction =
  | { readonly kind: "send"; readonly key: string; readonly label: string; readonly data: string }
  | { readonly kind: "clear"; readonly key: string; readonly label: string }
  | { readonly kind: "paste"; readonly key: string; readonly label: string }
  | {
      readonly kind: "modifier";
      readonly key: string;
      readonly label: string;
      readonly modifier: PendingModifier;
    };

function firstRouteParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first.trim().length === 0 ? null : first;
}

function inferHostPlatform(environmentLabel: string | null): HostPlatform {
  const value = environmentLabel?.toLowerCase() ?? "";
  if (
    value.includes("mac") ||
    value.includes("macbook") ||
    value.includes("mac mini") ||
    value.includes("imac") ||
    value.includes("darwin")
  ) {
    return "mac";
  }
  if (value.includes("windows") || value.includes("win")) {
    return "windows";
  }
  if (value.includes("linux") || value.includes("ubuntu") || value.includes("debian")) {
    return "linux";
  }

  return "unknown";
}

function pickRunningTerminalSessionForBootstrap(
  sessions: ReadonlyArray<KnownTerminalSession>,
): KnownTerminalSession | null {
  const running = sessions.filter(
    (session) => session.state.status === "running" || session.state.status === "starting",
  );
  if (running.length === 0) {
    return null;
  }
  return (
    running.find((session) => session.target.terminalId === DEFAULT_TERMINAL_ID) ??
    running[0] ??
    null
  );
}

type ThreadTerminalRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly terminalId?: string;
}>;

type ThreadSelection = ReturnType<typeof useThreadSelection>;

function useTerminalAccess(environmentId: EnvironmentId | null) {
  const session = useEnvironmentQuery(
    environmentId === null ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const isAuthenticated = session.error === null && session.data?.authenticated === true;
  return {
    session,
    isAuthenticated,
    canOperate:
      isAuthenticated &&
      session.data !== null &&
      sessionGrantsScope(session.data, AuthTerminalOperateScope),
    canRead:
      isAuthenticated &&
      session.data !== null &&
      sessionGrantsScope(session.data, AuthTerminalReadScope),
  };
}

export function ThreadTerminalRouteScreen(props: ThreadTerminalRouteScreenProps) {
  const connectionsReady = useConnectionsReady();
  const params = props.route.params;
  const selection = useThreadSelection();
  const { selectedThread } = selection;
  const routeEnvironmentIdRaw = firstRouteParam(params.environmentId);
  const routeEnvironmentId = routeEnvironmentIdRaw
    ? EnvironmentId.make(routeEnvironmentIdRaw)
    : null;
  const access = useTerminalAccess(routeEnvironmentId);
  const knownSessions = useKnownTerminalSessions({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
  const requestedTerminalId = firstRouteParam(params.terminalId);
  // A route without a terminal shows the thread's running one. The choice is
  // made once, from the first session list that has one, so the terminal shown
  // does not change under the user as sessions come and go.
  const [bootstrapTerminalId, setBootstrapTerminalId] = useState<string | null>(null);
  const runningSession = knownSessions.sessions
    ? (pickRunningTerminalSessionForBootstrap(knownSessions.sessions) ??
      (access.canOperate ? null : (knownSessions.sessions[0] ?? null)))
    : null;
  if (
    requestedTerminalId === null &&
    bootstrapTerminalId === null &&
    runningSession !== null &&
    runningSession.target.terminalId !== DEFAULT_TERMINAL_ID
  ) {
    setBootstrapTerminalId(runningSession.target.terminalId);
  }
  const explicitTerminalId = requestedTerminalId ?? bootstrapTerminalId;
  const terminalId = explicitTerminalId ?? DEFAULT_TERMINAL_ID;

  if (!selectedThread) {
    if (!connectionsReady) {
      return <LoadingScreen message="Opening terminal…" />;
    }

    return (
      <View className="flex-1 bg-screen">
        <EmptyState
          title="Thread unavailable"
          detail="This terminal route needs an active thread and workspace."
        />
      </View>
    );
  }

  return (
    <ThreadTerminal
      key={`${selectedThread.environmentId}:${selectedThread.id}:${terminalId}`}
      params={params}
      routeEnvironmentId={routeEnvironmentId}
      selection={selection}
      thread={selectedThread}
      terminalId={terminalId}
      hasExplicitTerminalId={explicitTerminalId !== null}
      access={access}
      knownSessions={knownSessions}
    />
  );
}

function readLiveTerminalSessions(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<TerminalMenuSession> {
  if (!readEnvironmentScope(environmentId, AuthTerminalReadScope)) return [];
  const result = appAtomRegistry.get(terminalEnvironment.metadata({ environmentId, input: null }));
  const summaries = Option.getOrElse(AsyncResult.value(result), () => []);
  return summaries
    .filter((summary) => summary.threadId === threadId)
    .map((summary) => ({
      terminalId: summary.terminalId,
      cwd: summary.cwd,
      status: summary.status,
      hasRunningSubprocess: summary.hasRunningSubprocess,
      displayLabel: resolveTerminalSessionLabel(summary.terminalId, summary),
      updatedAt: summary.updatedAt,
    }));
}

// `useKeyboardState` only flips on willShow and didHide; the accessory must
// leave as soon as the keyboard starts hiding, so it follows the will-events.
let keyboardShowing = KeyboardController.isVisible();
function subscribeKeyboardShowing(onChange: () => void) {
  keyboardShowing = KeyboardController.isVisible();
  const willShow = KeyboardEvents.addListener("keyboardWillShow", () => {
    keyboardShowing = true;
    onChange();
  });
  const willHide = KeyboardEvents.addListener("keyboardWillHide", () => {
    keyboardShowing = false;
    onChange();
  });
  return () => {
    willShow.remove();
    willHide.remove();
  };
}
const getKeyboardShowing = () => keyboardShowing;

function ThreadTerminal(props: {
  readonly params: ThreadTerminalRouteScreenProps["route"]["params"];
  readonly routeEnvironmentId: EnvironmentId | null;
  readonly selection: ThreadSelection;
  readonly thread: NonNullable<ThreadSelection["selectedThread"]>;
  readonly terminalId: string;
  readonly hasExplicitTerminalId: boolean;
  readonly access: ReturnType<typeof useTerminalAccess>;
  readonly knownSessions: ReturnType<typeof useKnownTerminalSessions>;
}) {
  const { params, routeEnvironmentId, thread: selectedThread, terminalId } = props;
  const { selectedThreadProject, selectedEnvironmentConnection } = props.selection;
  const {
    session: terminalSession,
    isAuthenticated,
    canOperate: canOperateTerminal,
    canRead: canReadTerminal,
  } = props.access;
  const {
    sessions: knownSessions,
    isPending: sessionsPending,
    error: sessionsError,
  } = props.knownSessions;
  const insets = useSafeAreaInsets();
  const nativeColumnMetrics = useNativeColumnLayoutMetrics();
  const navigation = useNavigation();
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const clearTerminal = useAtomCommand(terminalEnvironment.clear, "terminal clear");
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const selectedThreadDetail = useSelectedThreadProjection();
  const selectedThreadDetailWorktreePath =
    selectedThreadDetail?.projection.thread.worktreePath ?? null;
  const routeThreadIdRaw = firstRouteParam(params.threadId);
  const routeThreadId = routeThreadIdRaw ? ThreadId.make(routeThreadIdRaw) : null;
  const environment = useEnvironmentPresentation(routeEnvironmentId);
  const isEnvironmentReady = environment.presentation?.connection.phase === "connected";
  // Any new positive value triggers capture, even on remount. Pass one only while pending and keep increasing it.
  const captureSequenceRef = useRef(0);
  const [captureRequest, setCaptureRequest] = useState(0);
  const [capturedOutput, setCapturedOutput] = useState<string | null>(null);
  const requestCapture = () => {
    captureSequenceRef.current += 1;
    setCaptureRequest(captureSequenceRef.current);
  };
  const {
    isReady: hasResolvedFontPreference,
    appearance,
    themeAppearance: appearanceScheme,
    themeId,
    setTerminalFontSize,
    themeVariables,
  } = useAppearancePreferences();
  const fontSize = appearance.terminalFontSize;
  const terminalKey = `${selectedThread.environmentId}:${selectedThread.id}:${terminalId}`;
  const activeKnownSession =
    knownSessions?.find((session) => session.target.terminalId === terminalId) ?? null;
  const hasTerminalTarget = props.hasExplicitTerminalId || activeKnownSession !== null;
  const [pendingLaunch] = useState<PendingTerminalLaunch | null>(() =>
    takePendingTerminalLaunch({
      environmentId: selectedThread.environmentId,
      threadId: selectedThread.id,
      terminalId,
    }),
  );
  const [initialAttachGridSize] = useState(
    () =>
      (routeEnvironmentId && routeThreadId
        ? getCachedTerminalGridSize({
            environmentId: routeEnvironmentId,
            threadId: routeThreadId,
            terminalId,
          })
        : null) ?? { cols: DEFAULT_TERMINAL_COLS, rows: DEFAULT_TERMINAL_ROWS },
  );
  const [pasteSession] = useState(createTerminalPasteSession);
  const exitNavigation = useTerminalExitNavigation({
    environmentId: String(selectedThread.environmentId),
    threadId: String(selectedThread.id),
    readFallbackTerminalId: () =>
      previousLiveTerminalId({
        sessions: readLiveTerminalSessions(selectedThread.environmentId, selectedThread.id),
        exitedTerminalId: terminalId,
      }),
  });
  const [terminalSessionDriver] = useState(() =>
    terminalEnvironment.createSession({
      target: {
        environmentId: selectedThread.environmentId,
        threadId: selectedThread.id,
        terminalId,
      },
      gridSize: initialAttachGridSize,
      initialInput: pendingLaunch?.initialInput,
      canOperate: () =>
        readEnvironmentScope(selectedThread.environmentId, AuthTerminalOperateScope),
      onExit: exitNavigation.exited,
      onLiveChange: (live) => {
        if (live) exitNavigation.restarted();
        pasteSession.reset(live);
      },
    }),
  );
  const surfaceRef = useRef<TerminalSurfaceHandle>(null);
  const [keyboardFocusRequest, setKeyboardFocusRequest] = useState(0);
  const [pendingModifier, setPendingModifier] = useState<PendingModifier | null>(null);
  const launchLocation = useInitialTerminalLaunchLocation({
    targetKey: terminalKey,
    pendingLaunch,
    isAuthenticated,
    canRead: canReadTerminal,
    canOperate: canOperateTerminal,
    hasLoadedSessions: knownSessions !== null,
    location: selectedThreadProject?.workspaceRoot
      ? {
          terminalLocation: activeKnownSession?.state.summary ?? null,
          activeSessionLocation: activeKnownSession?.state.summary ?? null,
          workspaceRoot: selectedThreadProject.workspaceRoot,
          threadShellWorktreePath: selectedThread.worktreePath ?? null,
          threadDetailWorktreePath: selectedThreadDetailWorktreePath,
        }
      : null,
  });
  const terminalAttachInput = useMemo(
    () =>
      launchLocation !== null && hasResolvedFontPreference && isEnvironmentReady
        ? {
            threadId: selectedThread.id,
            terminalId,
            cwd: launchLocation.cwd,
            worktreePath: launchLocation.worktreePath,
            cols: initialAttachGridSize.cols,
            rows: initialAttachGridSize.rows,
            ...(pendingLaunch?.env ? { env: pendingLaunch.env } : {}),
            ...(pendingLaunch ? { restartIfNotRunning: true } : {}),
          }
        : null,
    [
      hasResolvedFontPreference,
      initialAttachGridSize,
      isEnvironmentReady,
      launchLocation,
      pendingLaunch,
      selectedThread.id,
      terminalId,
    ],
  );
  const observingTerminal = !canOperateTerminal && canReadTerminal && hasTerminalTarget;
  const streamingOutput = supportsNativeTerminalOutput();
  const terminal = useAttachedTerminalSession({
    materializeBuffer: !streamingOutput,
    environmentId: selectedThread.environmentId,
    terminal: canOperateTerminal
      ? terminalAttachInput
      : observingTerminal
        ? { threadId: selectedThread.id, terminalId }
        : null,
  });
  useAtomMount(
    terminalSessionDriver.driver(
      canOperateTerminal
        ? terminalAttachInput === null
          ? null
          : { kind: "attached", input: terminalAttachInput }
        : observingTerminal
          ? { kind: "observing" }
          : null,
    ),
  );
  const isRunning = terminal.status === "running" || terminal.status === "starting";

  const cwd = terminal.summary?.cwd ?? selectedThreadProject?.workspaceRoot ?? null;
  const serverConfigs = useServerConfigs();
  const hostOs =
    routeEnvironmentId === null
      ? null
      : (serverConfigs.get(routeEnvironmentId)?.environment.platform.os ?? null);
  const hostPlatform = useMemo(
    () =>
      hostPlatformFromOs(hostOs) ??
      inferHostPlatform(selectedEnvironmentConnection?.environmentLabel ?? null),
    [hostOs, selectedEnvironmentConnection?.environmentLabel],
  );

  const terminalTheme = getMobileTerminalTheme(themeId, appearanceScheme);
  const headerSubtitle = selectedThreadProject?.title ?? "";
  const terminalToolbarActions = useMemo<ReadonlyArray<TerminalToolbarAction>>(() => {
    const modifierActions: ReadonlyArray<TerminalToolbarAction> =
      hostPlatform === "mac"
        ? [
            { kind: "modifier", key: "cmd", label: "cmd", modifier: "meta" },
            { kind: "modifier", key: "ctrl", label: "ctrl", modifier: "ctrl" },
          ]
        : [
            { kind: "modifier", key: "ctrl", label: "ctrl", modifier: "ctrl" },
            { kind: "modifier", key: "alt", label: "alt", modifier: "meta" },
          ];

    return [
      { kind: "send", key: "up", label: "↑", data: "\u001b[A" },
      { kind: "send", key: "down", label: "↓", data: "\u001b[B" },
      { kind: "send", key: "left", label: "←", data: "\u001b[D" },
      { kind: "send", key: "right", label: "→", data: "\u001b[C" },
      { kind: "send", key: "esc", label: "esc", data: "\u001b" },
      ...modifierActions,
      { kind: "send", key: "tab", label: "tab", data: "\t" },
      { kind: "paste", key: "paste", label: "paste" },
      { kind: "clear", key: "clear", label: "clear" },
      { kind: "send", key: "tilde", label: "~", data: "~" },
      { kind: "send", key: "pipe", label: "|", data: "|" },
      { kind: "send", key: "slash", label: "/", data: "/" },
      { kind: "send", key: "dash", label: "-", data: "-" },
    ];
  }, [hostPlatform]);
  const keyboardState = useKeyboardState((state) => ({
    height: state.height,
    isVisible: state.isVisible,
  }));
  const keyboardShowing = useSyncExternalStore(subscribeKeyboardShowing, getKeyboardShowing);
  // The accessory follows the keyboard, except that the dismiss and show
  // buttons flip it ahead of the keyboard animation.
  const [accessory, setAccessory] = useState({ keyboardShowing, dismissed: false });
  if (accessory.keyboardShowing !== keyboardShowing) {
    setAccessory({ keyboardShowing, dismissed: !keyboardShowing });
  }
  const isAccessoryDismissed = accessory.dismissed;
  const isAccessoryVisible = canOperateTerminal && keyboardState.isVisible && !isAccessoryDismissed;
  // Android's terminal owns an EditText; turning off autoFocus also clears its native focus.
  const terminalAutoFocus =
    Platform.OS === "android"
      ? !isAccessoryDismissed &&
        (!SHOWCASE_ENABLED || keyboardFocusRequest > 0 || keyboardState.isVisible)
      : !SHOWCASE_ENABLED;
  const terminalBottomInset =
    (keyboardState.isVisible ? keyboardState.height : 0) +
    (isAccessoryVisible ? TERMINAL_ACCESSORY_HEIGHT : 0);

  const terminalMenuSessions: ReadonlyArray<TerminalMenuSession> = buildTerminalMenuSessions({
    knownSessions: knownSessions ?? [],
    workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
    currentSession: {
      terminalId,
      cwd: cwd ?? null,
      status: terminal.status,
      hasRunningSubprocess: terminal.hasRunningSubprocess,
      displayLabel: resolveTerminalSessionLabel(terminalId, terminal.summary),
      updatedAt: terminal.updatedAt,
    },
  });

  const writeInput = async (data: string): Promise<boolean> => {
    if (
      !isRunning ||
      !readEnvironmentScope(selectedThread.environmentId, AuthTerminalOperateScope)
    ) {
      return false;
    }

    const result = await writeTerminal({
      environmentId: selectedThread.environmentId,
      input: {
        threadId: selectedThread.id,
        terminalId,
        data,
      },
    });
    return result._tag === "Success";
  };

  const pasteFromClipboard = async () => {
    await pasteSession.paste({
      readText: Clipboard.getStringAsync,
      write: writeInput,
      onReadError: (cause) => {
        console.error(new TerminalClipboardReadError({ terminalId, cause }));
      },
    });
  };

  const writeModifiedInput = (data: string) => {
    if (pendingModifier === null) {
      void writeInput(data);
      return;
    }

    setPendingModifier(null);
    const resolved = resolveModifiedTerminalInput({
      data,
      modifier: pendingModifier,
      hostPlatform,
    });
    if (resolved.kind === "paste") {
      void pasteFromClipboard();
      return;
    }
    void writeInput(resolved.data);
  };

  const handleInput = (data: string) => {
    if (data.length === 0) {
      return;
    }

    writeModifiedInput(data);
  };

  const handleResize = (size: { readonly cols: number; readonly rows: number }) => {
    if (routeEnvironmentId && routeThreadId) {
      cacheTerminalGridSize(
        {
          environmentId: routeEnvironmentId,
          threadId: routeThreadId,
          terminalId,
        },
        size,
      );
    }
    terminalSessionDriver.reportGridSize(size);
  };

  const handleSelectTerminal = (nextTerminalId: string) => {
    if (nextTerminalId === terminalId) {
      return;
    }

    navigation.dispatch(
      StackActions.replace("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        terminalId: nextTerminalId,
      }),
    );
  };

  const handleCloseTerminal = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: params.environmentId,
        threadId: params.threadId,
      }),
    );
  };

  const handleOpenNewTerminal = () => {
    if (!readEnvironmentScope(selectedThread.environmentId, AuthTerminalOperateScope)) {
      return;
    }

    navigation.dispatch(
      StackActions.replace("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        terminalId: nextOpenTerminalId({
          listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
          activeRouteTerminalId: terminalId,
          ...(knownSessions === null ||
          !readEnvironmentScope(selectedThread.environmentId, AuthTerminalReadScope)
            ? { uniqueSuffix: uuidv4() }
            : {}),
        }),
      }),
    );
  };

  const handleDecreaseFontSize = () => {
    setTerminalFontSize(stepTerminalFontSize(fontSize, -1));
  };

  const handleIncreaseFontSize = () => {
    setTerminalFontSize(stepTerminalFontSize(fontSize, 1));
  };

  const handleClearTerminal = () => {
    if (!readEnvironmentScope(selectedThread.environmentId, AuthTerminalOperateScope)) {
      return;
    }

    setPendingModifier(null);
    void clearTerminal({
      environmentId: selectedThread.environmentId,
      input: {
        threadId: selectedThread.id,
        terminalId,
      },
    });
  };

  const handleToolbarActionPress = (action: TerminalToolbarAction) => {
    if (action.kind === "modifier") {
      setPendingModifier((current) => (current === action.modifier ? null : action.modifier));
      return;
    }

    if (action.kind === "clear") {
      handleClearTerminal();
      return;
    }

    if (action.kind === "paste") {
      setPendingModifier(null);
      void pasteFromClipboard();
      return;
    }

    writeModifiedInput(action.data);
  };

  const handleDismissKeyboard = () => {
    setAccessory((current) => ({ ...current, dismissed: true }));
    void KeyboardController.dismiss();
  };

  const handleShowKeyboard = () => {
    if (!canOperateTerminal) return;
    setAccessory((current) => ({ ...current, dismissed: false }));
    setKeyboardFocusRequest((current) => current + 1);
    surfaceRef.current?.focusKeyboard();
  };
  const handleRetryEnvironment = () => {
    if (routeEnvironmentId !== null) {
      void retryEnvironment(routeEnvironmentId);
    }
  };

  if (!selectedThreadProject?.workspaceRoot) {
    return (
      <View className="flex-1 bg-screen">
        <EmptyState
          title="Terminal unavailable"
          detail="This thread does not have a workspace root yet, so there is nowhere to open a shell."
        />
      </View>
    );
  }

  if (!environment.isReady && environment.presentation === null) {
    return <LoadingScreen message="Opening terminal…" />;
  }

  return (
    <>
      {capturedOutput !== null ? (
        <TerminalContextSheet
          text={capturedOutput}
          environmentId={selectedThread.environmentId}
          threadId={selectedThread.id}
          terminalId={terminalId}
          terminalLabel={resolveTerminalSessionLabel(terminalId, terminal.summary)}
          onClose={() => setCapturedOutput(null)}
          onAttach={() => {
            setCapturedOutput(null);
            if (navigation.canGoBack()) navigation.goBack();
          }}
        />
      ) : null}
      <TerminalHeader
        canOperateTerminal={canOperateTerminal}
        subtitle={headerSubtitle}
        isEnvironmentReady={isEnvironmentReady}
        fontSize={fontSize}
        terminalId={terminalId}
        sessions={terminalMenuSessions}
        status={{
          status: terminal.status,
          hasRunningSubprocess: terminal.hasRunningSubprocess,
        }}
        workspaceRoot={selectedThreadProject.workspaceRoot}
        onCloseTerminal={handleCloseTerminal}
        onDecreaseFontSize={handleDecreaseFontSize}
        onIncreaseFontSize={handleIncreaseFontSize}
        onOpenNewTerminal={handleOpenNewTerminal}
        onSelectTerminal={handleSelectTerminal}
      />

      <ScreenContent>
        <View
          className="flex-1"
          style={{
            backgroundColor:
              Platform.OS === "android"
                ? themeVariables["--color-card-alt"]
                : terminalTheme.background,
            // Measured top reservation is zero when UIKit already inset the body or moved the bar.
            paddingTop:
              Platform.OS === "ios" ? (nativeColumnMetrics?.safeArea.top ?? insets.top) : 0,
            paddingBottom:
              Platform.OS === "android" && !keyboardState.isVisible ? insets.bottom : 0,
          }}
        >
          {!isEnvironmentReady ? (
            <EnvironmentConnectionNotice
              environmentLabel={
                environment.presentation?.entry.target.label ??
                selectedEnvironmentConnection?.environmentLabel ??
                "Environment"
              }
              connection={
                environment.presentation?.connection ?? {
                  phase: "available",
                  error: null,
                  traceId: null,
                }
              }
              resourceName="terminal"
              onRetry={handleRetryEnvironment}
            />
          ) : terminalSession.data === null && terminalSession.error === null ? (
            <EmptyState
              title="Checking terminal access"
              detail="Waiting for this connection's permissions."
            />
          ) : !canReadTerminal && !canOperateTerminal ? (
            <EmptyState
              title={
                terminalSession.error
                  ? "Could not check terminal access"
                  : "Terminal access unavailable"
              }
              detail={
                terminalSession.error ??
                "This connection does not have permission to view terminals."
              }
            />
          ) : canOperateTerminal && launchLocation === null ? (
            sessionsError !== null ? (
              <EmptyState title="Could not load terminals" detail={sessionsError} />
            ) : (
              <EmptyState title="Loading terminals" detail="Reading existing terminal sessions." />
            )
          ) : !canOperateTerminal && !hasTerminalTarget && sessionsPending ? (
            <EmptyState title="Loading terminals" detail="Reading existing terminal sessions." />
          ) : !canOperateTerminal && !hasTerminalTarget && sessionsError !== null ? (
            <EmptyState title="Could not load terminals" detail={sessionsError} />
          ) : !canOperateTerminal && !hasTerminalTarget ? (
            <EmptyState
              title="No terminal sessions"
              detail="Existing terminals will appear here when another client opens one."
            />
          ) : !canOperateTerminal && terminal.error !== null ? (
            <EmptyState title="Terminal unavailable" detail={terminal.error} />
          ) : (
            <>
              <View
                style={{
                  flex: 1,
                  paddingBottom: terminalBottomInset,
                }}
              >
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    inset: 0,
                    backgroundColor: terminalTheme.background,
                  }}
                />
                <TerminalSurface
                  ref={surfaceRef}
                  autoFocus={canOperateTerminal && terminalAutoFocus}
                  readOnly={!canOperateTerminal}
                  buffer={terminal.version === 0 ? null : terminal.buffer}
                  output={terminal.version === 0 ? null : terminal.output}
                  fontSize={fontSize}
                  grid={terminal.grid}
                  isRunning={isRunning}
                  keyboardFocusRequest={keyboardFocusRequest}
                  captureRequest={captureRequest}
                  onCapture={(text) => {
                    setCaptureRequest(0);
                    if (text.trim()) setCapturedOutput(text);
                    else
                      Dialog.alert("No terminal output", "There is no visible output to attach.");
                  }}
                  onInput={handleInput}
                  onResize={handleResize}
                  style={{ flex: 1 }}
                  terminalKey={terminalKey}
                  theme={terminalTheme}
                />
              </View>

              {Platform.OS === "android" && !keyboardState.isVisible ? (
                <View className="min-h-14 flex-row items-center gap-2 bg-card-alt px-2">
                  {hasNativeTerminalSurface() ? (
                    <Button label="Attach output" tone="text" onPress={requestCapture} />
                  ) : null}
                  <View className="flex-1" />
                  <IconButton
                    accessibilityLabel="Show keyboard"
                    disabled={!canOperateTerminal}
                    icon="keyboard"
                    onPress={handleShowKeyboard}
                  />
                </View>
              ) : Platform.OS !== "android" && hasNativeTerminalSurface() ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    KeyboardController.dismiss();
                    requestCapture();
                  }}
                  className="px-4 py-2"
                >
                  <Text style={{ color: terminalTheme.foreground }}>Attach visible output</Text>
                </Pressable>
              ) : null}
              {isAccessoryVisible ? (
                <KeyboardStickyView
                  style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
                  offset={{ closed: 0, opened: 0 }}
                >
                  <View
                    className="border-t"
                    style={{
                      backgroundColor: terminalTheme.background,
                      borderTopColor: terminalTheme.border,
                      minHeight: TERMINAL_ACCESSORY_HEIGHT,
                    }}
                  >
                    <ComposerToolbarRow paddingBottom={4} paddingHorizontal={8} paddingTop={4}>
                      <ComposerToolbarScroller
                        contentPaddingRight={2}
                        fadeOpaque={terminalTheme.background}
                        fadeTransparent={`${terminalTheme.background}00`}
                      >
                        {terminalToolbarActions.map((action) => {
                          const active =
                            action.kind === "modifier" && pendingModifier === action.modifier;

                          return (
                            <ComposerToolbarButton
                              key={action.key}
                              active={active}
                              label={action.label}
                              maxWidth={120}
                              minWidth={action.label.length > 1 ? 56 : 44}
                              onPress={() => handleToolbarActionPress(action)}
                              showChevron={false}
                              textTransform={
                                action.kind === "modifier" || action.kind === "clear"
                                  ? "uppercase"
                                  : "none"
                              }
                            />
                          );
                        })}
                      </ComposerToolbarScroller>
                      <ComposerToolbarButton
                        accessibilityLabel="Dismiss keyboard"
                        icon={{ ios: "keyboard.chevron.compact.down", android: "keyboard_hide" }}
                        onPress={handleDismissKeyboard}
                        showChevron={false}
                      />
                    </ComposerToolbarRow>
                  </View>
                </KeyboardStickyView>
              ) : canOperateTerminal && !keyboardState.isVisible && Platform.OS !== "android" ? (
                <Pressable
                  accessibilityLabel="Show keyboard"
                  accessibilityRole="button"
                  onPress={handleShowKeyboard}
                  style={({ pressed }) => ({
                    bottom: 16,
                    borderRadius: 28,
                    opacity: pressed ? 0.72 : 1,
                    position: "absolute",
                    right: 16,
                  })}
                >
                  <GlassSurface
                    chrome="none"
                    fallbackColor={terminalTheme.background}
                    glassEffectStyle="regular"
                    tintColor="transparent"
                    style={{
                      alignItems: "center",
                      borderRadius: 24,
                      height: 48,
                      justifyContent: "center",
                      width: 48,
                    }}
                    pointerEvents="none"
                  >
                    <SymbolView
                      name={{ ios: "keyboard", android: "keyboard" }}
                      size={20}
                      tintColor={terminalTheme.foreground}
                      type="monochrome"
                    />
                  </GlassSurface>
                </Pressable>
              ) : null}
            </>
          )}
        </View>
      </ScreenContent>
    </>
  );
}
