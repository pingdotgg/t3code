import { DEFAULT_TERMINAL_ID, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import type { MenuAction } from "@react-native-menu/menu";
import { SymbolView } from "../../components/AppSymbol";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, View, useColorScheme } from "react-native";
import {
  KeyboardController,
  KeyboardEvents,
  KeyboardStickyView,
  useKeyboardState,
} from "react-native-keyboard-controller";

import { AndroidHeaderIconButton, AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import {
  ComposerToolbarButton,
  ComposerToolbarRow,
  ComposerToolbarScroller,
} from "../../components/ComposerToolbarTrigger";
import { ControlPillMenu } from "../../components/ControlPill";
import { EmptyState } from "../../components/EmptyState";
import { GlassSurface } from "../../components/GlassSurface";
import { LoadingScreen } from "../../components/LoadingScreen";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentPresentation } from "../../state/presentation";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceState } from "../../state/workspace";
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
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { EnvironmentConnectionNotice } from "../connection/EnvironmentConnectionNotice";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { TerminalSurface } from "./NativeTerminalSurface";
import { getPierreTerminalTheme } from "./terminalTheme";
import { terminalDebugLog } from "./terminalDebugLog";
import {
  getTerminalBufferReplayKey,
  getTerminalSurfaceReplayBuffer,
  TERMINAL_BUFFER_REPLAY_STABILITY_DELAY_MS,
} from "./terminalBufferReplay";
import {
  resolveTerminalOpenLocation,
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
import { cacheTerminalGridSize, getCachedTerminalGridSize } from "./terminalUiState";

const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const TERMINAL_ACCESSORY_HEIGHT = 52;

type PendingModifier = "ctrl" | "meta";
type HostPlatform = "mac" | "linux" | "windows" | "unknown";

type TerminalToolbarAction =
  | { readonly kind: "send"; readonly key: string; readonly label: string; readonly data: string }
  | { readonly kind: "clear"; readonly key: string; readonly label: string }
  | {
      readonly kind: "modifier";
      readonly key: string;
      readonly label: string;
      readonly modifier: PendingModifier;
    };

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
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

function applyCtrlModifier(input: string): string {
  const firstCharacter = input[0];
  if (!firstCharacter) {
    return input;
  }

  const lowerCharacter = firstCharacter.toLowerCase();
  if (lowerCharacter >= "a" && lowerCharacter <= "z") {
    return String.fromCharCode(lowerCharacter.charCodeAt(0) - 96);
  }

  if (firstCharacter === "@") return "\u0000";
  if (firstCharacter === "[") return "\u001b";
  if (firstCharacter === "\\") return "\u001c";
  if (firstCharacter === "]") return "\u001d";
  if (firstCharacter === "^") return "\u001e";
  if (firstCharacter === "_") return "\u001f";
  if (firstCharacter === "?") return "\u007f";

  return input;
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

export function ThreadTerminalRouteScreen(props: ThreadTerminalRouteScreenProps) {
  const navigation = useNavigation();
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const resizeTerminal = useAtomCommand(terminalEnvironment.resize, "terminal resize");
  const clearTerminal = useAtomCommand(terminalEnvironment.clear, "terminal clear");
  const closeTerminal = useAtomCommand(terminalEnvironment.close, "terminal close");
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const appearanceScheme = useColorScheme() === "light" ? "light" : "dark";
  const { state: workspaceState } = useWorkspaceState();
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const params = props.route.params;
  const { selectedThread, selectedThreadProject, selectedEnvironmentConnection } =
    useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const routeEnvironmentIdRaw = firstRouteParam(params.environmentId);
  const routeThreadIdRaw = firstRouteParam(params.threadId);
  const routeEnvironmentId = routeEnvironmentIdRaw
    ? EnvironmentId.make(routeEnvironmentIdRaw)
    : null;
  const routeThreadId = routeThreadIdRaw ? ThreadId.make(routeThreadIdRaw) : null;
  const environment = useEnvironmentPresentation(routeEnvironmentId);
  const isEnvironmentReady = environment.presentation?.connection.phase === "connected";
  const requestedTerminalId = firstRouteParam(params.terminalId);
  const terminalId = requestedTerminalId ?? DEFAULT_TERMINAL_ID;
  const {
    isReady: hasResolvedFontPreference,
    appearance,
    setTerminalFontSize,
  } = useAppearancePreferences();
  const fontSize = appearance.terminalFontSize;
  const cachedRouteGridSize =
    routeEnvironmentId && routeThreadId
      ? getCachedTerminalGridSize({
          environmentId: routeEnvironmentId,
          threadId: routeThreadId,
          terminalId,
        })
      : null;
  const knownSessions = useKnownTerminalSessions({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
  const runningSession = useMemo(
    () => pickRunningTerminalSessionForBootstrap(knownSessions),
    [knownSessions],
  );
  const activeKnownSession = useMemo(
    () => knownSessions.find((session) => session.target.terminalId === terminalId) ?? null,
    [knownSessions, terminalId],
  );
  const launchTarget = useMemo(
    () =>
      selectedThread
        ? {
            environmentId: selectedThread.environmentId,
            threadId: selectedThread.id,
            terminalId,
          }
        : null,
    [selectedThread, terminalId],
  );
  const launchTargetKey = launchTarget
    ? `${launchTarget.environmentId}:${launchTarget.threadId}:${launchTarget.terminalId}`
    : null;
  const [pendingLaunchEntry, setPendingLaunchEntry] = useState<{
    readonly key: string | null;
    readonly launch: PendingTerminalLaunch | null;
  }>(() => ({
    key: launchTargetKey,
    launch: launchTarget === null ? null : takePendingTerminalLaunch(launchTarget),
  }));
  const pendingLaunch =
    pendingLaunchEntry.key === launchTargetKey ? pendingLaunchEntry.launch : null;
  const hasResolvedPendingLaunch = pendingLaunchEntry.key === launchTargetKey;
  const [initialAttachGridEntry, setInitialAttachGridEntry] = useState(() => ({
    key: launchTargetKey,
    size: cachedRouteGridSize ?? {
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
    },
  }));
  const initialAttachGridSize =
    initialAttachGridEntry.key === launchTargetKey ? initialAttachGridEntry.size : null;
  const [lastGridSize, setLastGridSize] = useState(
    cachedRouteGridSize ?? {
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
    },
  );
  const [keyboardFocusRequest, setKeyboardFocusRequest] = useState(0);
  const [isAccessoryDismissed, setIsAccessoryDismissed] = useState(false);
  const bufferReplayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstNonEmptyBufferLoggedRef = useRef(false);
  const lastBufferReplayKeyRef = useRef<string | null>(null);
  const sentInitialInputKeyRef = useRef<string | null>(null);
  const [readyBufferReplayKey, setReadyBufferReplayKey] = useState<string | null>(null);
  /** Default grid is always valid for attach; onResize refines cols/rows. Requiring a cached size blocked bootstrap for new terminal routes. */
  const [hasMeasuredSurface, setHasMeasuredSurface] = useState(true);
  const [pendingModifierState, setPendingModifierState] = useState<{
    readonly terminalId: string;
    readonly value: PendingModifier | null;
  }>({
    terminalId,
    value: null,
  });
  const shouldRedirectToRunningTerminal =
    requestedTerminalId === null &&
    runningSession !== null &&
    runningSession.target.terminalId !== terminalId;
  const launchLocationCandidate = useMemo(() => {
    if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
      return null;
    }
    if (pendingLaunch) {
      return {
        cwd: pendingLaunch.cwd,
        worktreePath: pendingLaunch.worktreePath,
      };
    }
    return resolveTerminalOpenLocation({
      terminalLocation: activeKnownSession?.state.summary ?? null,
      activeSessionLocation: activeKnownSession?.state.summary ?? null,
      workspaceRoot: selectedThreadProject.workspaceRoot,
      threadShellWorktreePath: selectedThread.worktreePath ?? null,
      threadDetailWorktreePath: selectedThreadDetail?.worktreePath ?? null,
    });
  }, [
    activeKnownSession?.state.summary,
    pendingLaunch,
    selectedThread,
    selectedThreadDetail?.worktreePath,
    selectedThreadProject?.workspaceRoot,
  ]);
  const [initialLaunchLocationEntry, setInitialLaunchLocationEntry] = useState(() => ({
    key: launchTargetKey,
    location: launchLocationCandidate,
  }));
  const launchLocation =
    initialLaunchLocationEntry.key === launchTargetKey ? initialLaunchLocationEntry.location : null;
  const terminalAttachInput = useMemo(
    () =>
      selectedThread !== null &&
      launchLocation !== null &&
      hasResolvedPendingLaunch &&
      initialAttachGridSize !== null &&
      hasResolvedFontPreference &&
      hasMeasuredSurface &&
      isEnvironmentReady &&
      !shouldRedirectToRunningTerminal
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
      hasMeasuredSurface,
      hasResolvedFontPreference,
      hasResolvedPendingLaunch,
      initialAttachGridSize,
      isEnvironmentReady,
      launchLocation,
      pendingLaunch,
      selectedThread,
      shouldRedirectToRunningTerminal,
      terminalId,
    ],
  );
  const terminal = useAttachedTerminalSession({
    environmentId: selectedThread?.environmentId ?? null,
    terminal: terminalAttachInput,
  });
  const terminalKey = selectedThread
    ? `${selectedThread.environmentId}:${selectedThread.id}:${terminalId}`
    : terminalId;
  const bufferReplayKey = useMemo(
    () => getTerminalBufferReplayKey({ terminalKey, fontSize }),
    [fontSize, terminalKey],
  );
  if (lastBufferReplayKeyRef.current === null) {
    lastBufferReplayKeyRef.current = bufferReplayKey;
  }
  const terminalSurfaceBuffer = getTerminalSurfaceReplayBuffer({
    buffer: terminal.buffer,
    replayKey: bufferReplayKey,
    readyReplayKey: readyBufferReplayKey,
  });
  const isRunning = terminal.status === "running" || terminal.status === "starting";

  // When the process ends while this screen is attached (e.g. typing `exit`),
  // close the session and leave the screen, mirroring the web drawer's
  // onSessionExited flow. Only react to a running -> exited transition
  // observed on this screen so already-exited sessions can still be opened
  // (they restart on attach).
  const runningTerminalKeyRef = useRef<string | null>(null);
  const reopenedStaleTerminalKeyRef = useRef<string | null>(null);
  const pendingExitNavigationRef = useRef<string | null>(null);

  // Attach subscriptions are cached with an idle TTL, so revisiting a
  // terminal whose session ended while unobserved reuses the stale stream
  // without a new attach RPC — the server never respawns anything. Detect
  // that (dead status with processed events, never seen running here) and
  // issue an explicit open; its snapshot flows into the live subscription.
  useEffect(() => {
    if (isRunning) {
      reopenedStaleTerminalKeyRef.current = null;
      return;
    }
    if (
      terminalAttachInput === null ||
      !selectedThread ||
      (terminal.status !== "closed" && terminal.status !== "exited") ||
      terminal.version === 0 ||
      runningTerminalKeyRef.current === terminalKey ||
      reopenedStaleTerminalKeyRef.current === terminalKey
    ) {
      return;
    }
    reopenedStaleTerminalKeyRef.current = terminalKey;
    void openTerminal({
      environmentId: selectedThread.environmentId,
      input: {
        threadId: selectedThread.id,
        terminalId,
        cwd: terminalAttachInput.cwd,
        worktreePath: terminalAttachInput.worktreePath,
        cols: terminalAttachInput.cols,
        rows: terminalAttachInput.rows,
        ...(terminalAttachInput.env ? { env: terminalAttachInput.env } : {}),
      },
    }).then((result) => {
      // Release the guard on failure so a later render can retry the respawn.
      if (result._tag === "Failure" && reopenedStaleTerminalKeyRef.current === terminalKey) {
        reopenedStaleTerminalKeyRef.current = null;
      }
    });
  }, [
    isRunning,
    openTerminal,
    selectedThread,
    terminal.status,
    terminal.version,
    terminalAttachInput,
    terminalId,
    terminalKey,
  ]);

  useEffect(() => {
    terminalDebugLog("surface:props", {
      terminalKey,
      atomBufferLen: terminal.buffer.length,
      surfaceBufferLen: terminalSurfaceBuffer.length,
      replayKey: bufferReplayKey,
      readyReplayKey: readyBufferReplayKey,
      status: terminal.status,
      version: terminal.version,
    });
  }, [
    bufferReplayKey,
    readyBufferReplayKey,
    terminal.buffer.length,
    terminal.status,
    terminal.version,
    terminalKey,
    terminalSurfaceBuffer.length,
  ]);

  useEffect(() => {
    terminalDebugLog("session:status", {
      terminalKey,
      status: terminal.status,
      error: terminal.error,
      summary: terminal.summary?.cwd ?? null,
      bufferLen: terminal.buffer.length,
      version: terminal.version,
    });
  }, [
    terminal.buffer.length,
    terminal.error,
    terminal.status,
    terminal.summary?.cwd,
    terminal.version,
    terminalKey,
  ]);

  useEffect(() => {
    if (terminal.buffer.length === 0 || firstNonEmptyBufferLoggedRef.current) {
      return;
    }
    firstNonEmptyBufferLoggedRef.current = true;
    terminalDebugLog("session:first-nonempty-buffer", {
      terminalKey,
      length: terminal.buffer.length,
      preview: terminal.buffer.slice(0, 160),
    });
  }, [terminal.buffer, terminal.buffer.length, terminalKey]);
  const cwd = terminal.summary?.cwd ?? selectedThreadProject?.workspaceRoot ?? null;
  const hostPlatform = useMemo(
    () => inferHostPlatform(selectedEnvironmentConnection?.environmentLabel ?? null),
    [selectedEnvironmentConnection?.environmentLabel],
  );

  const terminalTheme = getPierreTerminalTheme(appearanceScheme);
  const usesNativeHeaderGlass = Platform.OS === "ios";
  const pendingModifier =
    pendingModifierState.terminalId === terminalId ? pendingModifierState.value : null;
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
      { kind: "send", key: "esc", label: "esc", data: "\u001b" },
      ...modifierActions,
      { kind: "send", key: "tab", label: "tab", data: "\t" },
      { kind: "clear", key: "clear", label: "clear" },
      { kind: "send", key: "up", label: "↑", data: "\u001b[A" },
      { kind: "send", key: "down", label: "↓", data: "\u001b[B" },
      { kind: "send", key: "left", label: "←", data: "\u001b[D" },
      { kind: "send", key: "right", label: "→", data: "\u001b[C" },
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
  const isAccessoryVisible = keyboardState.isVisible && !isAccessoryDismissed;
  const terminalBottomInset =
    (keyboardState.isVisible ? keyboardState.height : 0) +
    (isAccessoryVisible ? TERMINAL_ACCESSORY_HEIGHT : 0);

  useEffect(() => {
    const keyboardWillShow = KeyboardEvents.addListener("keyboardWillShow", () => {
      setIsAccessoryDismissed(false);
    });
    const keyboardWillHide = KeyboardEvents.addListener("keyboardWillHide", () => {
      setIsAccessoryDismissed(true);
    });

    return () => {
      keyboardWillShow.remove();
      keyboardWillHide.remove();
    };
  }, []);

  const terminalMenuSessions = useMemo<ReadonlyArray<TerminalMenuSession>>(
    () =>
      buildTerminalMenuSessions({
        knownSessions,
        workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
        currentSession: {
          terminalId,
          cwd: cwd ?? null,
          status: terminal.status,
          hasRunningSubprocess: terminal.hasRunningSubprocess,
          displayLabel: resolveTerminalSessionLabel(terminalId, terminal.summary),
          updatedAt: terminal.updatedAt,
        },
      }),
    [
      cwd,
      knownSessions,
      selectedThreadProject?.workspaceRoot,
      terminal.hasRunningSubprocess,
      terminal.summary,
      terminal.status,
      terminal.updatedAt,
      terminalId,
    ],
  );

  useEffect(() => {
    if (pendingLaunchEntry.key === launchTargetKey) {
      return;
    }
    setPendingLaunchEntry({
      key: launchTargetKey,
      launch: launchTarget === null ? null : takePendingTerminalLaunch(launchTarget),
    });
  }, [launchTarget, launchTargetKey, pendingLaunchEntry.key]);

  useEffect(() => {
    if (initialAttachGridEntry.key === launchTargetKey) {
      return;
    }
    setInitialAttachGridEntry({
      key: launchTargetKey,
      size: cachedRouteGridSize ?? {
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
      },
    });
  }, [cachedRouteGridSize, initialAttachGridEntry.key, launchTargetKey]);

  useEffect(() => {
    if (
      initialLaunchLocationEntry.key === launchTargetKey &&
      initialLaunchLocationEntry.location !== null
    ) {
      return;
    }
    if (initialLaunchLocationEntry.key === launchTargetKey && launchLocationCandidate === null) {
      return;
    }
    setInitialLaunchLocationEntry({
      key: launchTargetKey,
      location: launchLocationCandidate,
    });
  }, [
    initialLaunchLocationEntry.key,
    initialLaunchLocationEntry.location,
    launchLocationCandidate,
    launchTargetKey,
  ]);

  useEffect(() => {
    if (!shouldRedirectToRunningTerminal || !selectedThread || !runningSession) {
      return;
    }
    navigation.dispatch(
      StackActions.replace("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        terminalId: runningSession.target.terminalId,
      }),
    );
  }, [navigation, runningSession, selectedThread, shouldRedirectToRunningTerminal]);

  useEffect(() => {
    const initialInput = pendingLaunch?.initialInput;
    if (
      !initialInput ||
      !selectedThread ||
      terminal.version === 0 ||
      sentInitialInputKeyRef.current === launchTargetKey
    ) {
      return;
    }
    sentInitialInputKeyRef.current = launchTargetKey;
    void writeTerminal({
      environmentId: selectedThread.environmentId,
      input: {
        threadId: selectedThread.id,
        terminalId,
        data: initialInput,
      },
    });
  }, [
    launchTargetKey,
    pendingLaunch?.initialInput,
    selectedThread,
    terminal.version,
    terminalId,
    writeTerminal,
  ]);

  useEffect(() => {
    firstNonEmptyBufferLoggedRef.current = false;
    sentInitialInputKeyRef.current = null;
  }, [terminalKey]);

  const clearBufferReplayTimer = useCallback(() => {
    if (bufferReplayTimerRef.current !== null) {
      clearTimeout(bufferReplayTimerRef.current);
      bufferReplayTimerRef.current = null;
    }
  }, []);

  const scheduleBufferReplayReady = useCallback(() => {
    clearBufferReplayTimer();
    const replayKey = bufferReplayKey;
    terminalDebugLog("replay:schedule-ready", {
      replayKey,
      delayMs: TERMINAL_BUFFER_REPLAY_STABILITY_DELAY_MS,
    });
    bufferReplayTimerRef.current = setTimeout(() => {
      bufferReplayTimerRef.current = null;
      setReadyBufferReplayKey(replayKey);
      terminalDebugLog("replay:ready", { replayKey });
    }, TERMINAL_BUFFER_REPLAY_STABILITY_DELAY_MS);
  }, [bufferReplayKey, clearBufferReplayTimer]);

  useEffect(() => {
    if (lastBufferReplayKeyRef.current === bufferReplayKey) {
      return;
    }

    lastBufferReplayKeyRef.current = bufferReplayKey;
    clearBufferReplayTimer();
    setReadyBufferReplayKey(null);
  }, [bufferReplayKey, clearBufferReplayTimer]);

  useEffect(() => clearBufferReplayTimer, [clearBufferReplayTimer]);

  useEffect(() => {
    if (!routeEnvironmentId || !routeThreadId) {
      setLastGridSize({
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
      });
      return;
    }

    setLastGridSize(
      getCachedTerminalGridSize({
        environmentId: routeEnvironmentId,
        threadId: routeThreadId,
        terminalId,
      }) ?? {
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
      },
    );
    setHasMeasuredSurface(true);
  }, [routeEnvironmentId, routeThreadId, terminalId]);

  const writeInput = useCallback(
    (data: string) => {
      if (!selectedThread || !isRunning) {
        return;
      }

      void writeTerminal({
        environmentId: selectedThread.environmentId,
        input: {
          threadId: selectedThread.id,
          terminalId,
          data,
        },
      });
    },
    [isRunning, selectedThread, terminalId, writeTerminal],
  );

  const handleInput = useCallback(
    (data: string) => {
      if (data.length === 0) {
        return;
      }

      if (pendingModifier === "ctrl") {
        setPendingModifierState({ terminalId, value: null });
        writeInput(applyCtrlModifier(data));
      } else if (pendingModifier === "meta") {
        setPendingModifierState({ terminalId, value: null });
        writeInput(`\u001b${data}`);
      } else {
        writeInput(data);
      }
    },
    [pendingModifier, terminalId, writeInput],
  );

  const handleResize = useCallback(
    (size: { readonly cols: number; readonly rows: number }) => {
      terminalDebugLog("native:onResize", {
        cols: size.cols,
        rows: size.rows,
        terminalKey,
      });
      setHasMeasuredSurface(true);
      if (readyBufferReplayKey !== bufferReplayKey) {
        scheduleBufferReplayReady();
      }
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
      if (size.cols === lastGridSize.cols && size.rows === lastGridSize.rows) {
        return;
      }

      setLastGridSize(size);
      if (!selectedThread || !isRunning) {
        return;
      }

      void resizeTerminal({
        environmentId: selectedThread.environmentId,
        input: {
          threadId: selectedThread.id,
          terminalId,
          cols: size.cols,
          rows: size.rows,
        },
      });
    },
    [
      isRunning,
      lastGridSize.cols,
      lastGridSize.rows,
      bufferReplayKey,
      readyBufferReplayKey,
      routeEnvironmentId,
      routeThreadId,
      resizeTerminal,
      scheduleBufferReplayReady,
      selectedThread,
      terminalId,
      terminalKey,
    ],
  );

  const handleSelectTerminal = useCallback(
    (nextTerminalId: string) => {
      if (!selectedThread || nextTerminalId === terminalId) {
        return;
      }

      navigation.dispatch(
        StackActions.replace("ThreadTerminal", {
          environmentId: String(selectedThread.environmentId),
          threadId: String(selectedThread.id),
          terminalId: nextTerminalId,
        }),
      );
    },
    [navigation, selectedThread, terminalId],
  );

  const navigateAwayAfterExit = useCallback(() => {
    // With other shells still live, fall through to the previous one instead
    // of dropping the user back on the thread.
    const fallbackTerminalId = previousLiveTerminalId({
      sessions: terminalMenuSessions,
      exitedTerminalId: terminalId,
    });
    if (fallbackTerminalId !== null && selectedThread) {
      navigation.dispatch(
        StackActions.replace("ThreadTerminal", {
          environmentId: String(selectedThread.environmentId),
          threadId: String(selectedThread.id),
          terminalId: fallbackTerminalId,
        }),
      );
      return;
    }
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    // Deep-linked/root mounts have nothing to pop; land on the thread
    // instead of stranding the user on a dead terminal.
    if (selectedThread) {
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: String(selectedThread.environmentId),
          threadId: String(selectedThread.id),
        }),
      );
    }
  }, [navigation, selectedThread, terminalId, terminalMenuSessions]);

  useEffect(() => {
    if (isRunning) {
      runningTerminalKeyRef.current = terminalKey;
      return;
    }
    // The web drawer treats both exited and closed as session end.
    const sessionEnded = terminal.status === "exited" || terminal.status === "closed";
    if (!sessionEnded || runningTerminalKeyRef.current !== terminalKey) {
      return;
    }
    runningTerminalKeyRef.current = null;
    // Mark this key handled so the stale-attach effect doesn't respawn the
    // session the user just ended.
    reopenedStaleTerminalKeyRef.current = terminalKey;
    if (selectedThread) {
      void closeTerminal({
        environmentId: selectedThread.environmentId,
        input: {
          threadId: selectedThread.id,
          terminalId,
        },
      });
    }
    if (navigation.isFocused()) {
      navigateAwayAfterExit();
      return;
    }
    // An unfocused screen can't navigate; leave when the user returns so
    // they never land on the dead session.
    pendingExitNavigationRef.current = terminalKey;
  }, [
    closeTerminal,
    isRunning,
    navigateAwayAfterExit,
    navigation,
    selectedThread,
    terminal.status,
    terminalId,
    terminalKey,
  ]);

  useEffect(
    () =>
      navigation.addListener("focus", () => {
        if (pendingExitNavigationRef.current !== terminalKey) {
          return;
        }
        pendingExitNavigationRef.current = null;
        navigateAwayAfterExit();
      }),
    [navigateAwayAfterExit, navigation, terminalKey],
  );

  const handleOpenNewTerminal = useCallback(() => {
    if (!selectedThread) {
      return;
    }

    navigation.dispatch(
      StackActions.replace("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        terminalId: nextOpenTerminalId({
          listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
          activeRouteTerminalId: terminalId,
        }),
      }),
    );
  }, [navigation, selectedThread, terminalId, terminalMenuSessions]);

  const handleDecreaseFontSize = useCallback(() => {
    setTerminalFontSize(stepTerminalFontSize(fontSize, -1));
  }, [fontSize, setTerminalFontSize]);

  const handleIncreaseFontSize = useCallback(() => {
    setTerminalFontSize(stepTerminalFontSize(fontSize, 1));
  }, [fontSize, setTerminalFontSize]);

  // Android mirror of the iOS NativeHeaderToolbar terminal menu below: text
  // size, session switching, and "Open new terminal", rendered through the
  // token-styled anchored menu (the native header items are iOS-only).
  const androidTerminalMenuActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "text-size",
        title: "Text size",
        subactions: [
          {
            id: "font-decrease",
            title: `A- ${Math.max(MIN_TERMINAL_FONT_SIZE, fontSize - TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`,
            attributes: fontSize <= MIN_TERMINAL_FONT_SIZE ? { disabled: true } : undefined,
          },
          {
            id: "font-increase",
            title: `A+ ${Math.min(MAX_TERMINAL_FONT_SIZE, fontSize + TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`,
            attributes: fontSize >= MAX_TERMINAL_FONT_SIZE ? { disabled: true } : undefined,
          },
        ],
      },
      ...terminalMenuSessions.map(
        (session): MenuAction => ({
          id: `terminal-session:${session.terminalId}`,
          title: session.displayLabel,
          subtitle: [getTerminalStatusLabel({ status: session.status }), basename(session.cwd)]
            .filter(Boolean)
            .join(" · "),
          state: session.terminalId === terminalId ? ("on" as const) : undefined,
        }),
      ),
      {
        id: "terminal-new",
        title: "Open new terminal",
        image: "plus",
        subtitle: `Start another shell in ${basename(selectedThreadProject?.workspaceRoot ?? null) ?? "this workspace"}`,
      },
    ],
    [fontSize, selectedThreadProject?.workspaceRoot, terminalId, terminalMenuSessions],
  );

  const handleAndroidTerminalMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const id = event.nativeEvent.event;
      if (id === "font-decrease") {
        handleDecreaseFontSize();
        return;
      }
      if (id === "font-increase") {
        handleIncreaseFontSize();
        return;
      }
      if (id === "terminal-new") {
        handleOpenNewTerminal();
        return;
      }
      if (id.startsWith("terminal-session:")) {
        handleSelectTerminal(id.slice("terminal-session:".length));
      }
    },
    [handleDecreaseFontSize, handleIncreaseFontSize, handleOpenNewTerminal, handleSelectTerminal],
  );

  const handleClearTerminal = useCallback(() => {
    if (!selectedThread) {
      return;
    }

    setPendingModifierState({ terminalId, value: null });
    void clearTerminal({
      environmentId: selectedThread.environmentId,
      input: {
        threadId: selectedThread.id,
        terminalId,
      },
    });
  }, [clearTerminal, selectedThread, terminalId]);

  const handleToolbarActionPress = useCallback(
    (action: TerminalToolbarAction) => {
      if (action.kind === "modifier") {
        setPendingModifierState((current) => ({
          terminalId,
          value:
            (current.terminalId === terminalId ? current.value : null) === action.modifier
              ? null
              : action.modifier,
        }));
        return;
      }

      if (action.kind === "clear") {
        handleClearTerminal();
        return;
      }

      setPendingModifierState({ terminalId, value: null });
      if (pendingModifier === "ctrl") {
        writeInput(applyCtrlModifier(action.data));
      } else if (pendingModifier === "meta") {
        writeInput(`\u001b${action.data}`);
      } else {
        writeInput(action.data);
      }
    },
    [handleClearTerminal, pendingModifier, terminalId, writeInput],
  );

  const handleDismissKeyboard = useCallback(() => {
    setIsAccessoryDismissed(true);
    void KeyboardController.dismiss();
  }, []);

  const handleShowKeyboard = useCallback(() => {
    setKeyboardFocusRequest((current) => current + 1);
  }, []);
  const handleRetryEnvironment = useCallback(() => {
    if (routeEnvironmentId !== null) {
      void retryEnvironment(routeEnvironmentId);
    }
  }, [retryEnvironment, routeEnvironmentId]);

  if (!selectedThread) {
    if (workspaceState.isLoadingConnections) {
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
      <NativeStackScreenOptions
        options={{
          // Static header config lives in Stack.tsx (SOLID_HEADER_OPTIONS — the pty
          // scrolls internally, nothing for glass to sample). Default title/subtitle
          // styling, like every other page.
          // Android draws its own in-flow header (AndroidScreenHeader below);
          // the native stack header stays iOS-only.
          headerShown: Platform.OS !== "android",
          title: "Terminal",
          unstable_headerSubtitle:
            usesNativeHeaderGlass && headerSubtitle.length > 0 ? headerSubtitle : undefined,
        }}
      />

      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title="Terminal"
          subtitle={headerSubtitle}
          onBack={navigation.canGoBack() ? () => navigation.goBack() : undefined}
          trailing={
            <>
              {layout.usesSplitView ? (
                <AndroidHeaderIconButton
                  accessibilityLabel={
                    panes.primarySidebarVisible ? "Maximize terminal" : "Show threads"
                  }
                  icon={
                    panes.primarySidebarVisible
                      ? "arrow.up.left.and.arrow.down.right"
                      : "sidebar.left"
                  }
                  onPress={togglePrimarySidebar}
                />
              ) : null}
              {isEnvironmentReady ? (
                <ControlPillMenu
                  actions={androidTerminalMenuActions}
                  isAnchoredToRight
                  title={getTerminalStatusLabel({
                    status: terminal.status,
                    hasRunningSubprocess: terminal.hasRunningSubprocess,
                  })}
                  onPressAction={handleAndroidTerminalMenuAction}
                >
                  <AndroidHeaderIconButton accessibilityLabel="Terminal options" icon="terminal" />
                </ControlPillMenu>
              ) : null}
            </>
          }
        />
      ) : null}

      {layout.usesSplitView ? (
        <NativeHeaderToolbar placement="left">
          <NativeHeaderToolbar.Button
            accessibilityLabel={panes.primarySidebarVisible ? "Maximize terminal" : "Show threads"}
            icon={
              panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left"
            }
            onPress={togglePrimarySidebar}
            separateBackground
          />
        </NativeHeaderToolbar>
      ) : null}

      {isEnvironmentReady ? (
        <NativeHeaderToolbar placement="right">
          <NativeHeaderToolbar.Menu icon="terminal" title="Terminal options" separateBackground>
            <NativeHeaderToolbar.Label>
              {getTerminalStatusLabel({
                status: terminal.status,
                hasRunningSubprocess: terminal.hasRunningSubprocess,
              })}
            </NativeHeaderToolbar.Label>
            <NativeHeaderToolbar.Menu icon="textformat.size" inline title="Text size">
              <NativeHeaderToolbar.Label>Text size</NativeHeaderToolbar.Label>
              <NativeHeaderToolbar.MenuAction
                disabled={fontSize <= MIN_TERMINAL_FONT_SIZE}
                discoverabilityLabel="Decrease terminal text size"
                onPress={handleDecreaseFontSize}
              >
                <NativeHeaderToolbar.Label>{`A- ${Math.max(MIN_TERMINAL_FONT_SIZE, fontSize - TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`}</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
              <NativeHeaderToolbar.MenuAction
                disabled={fontSize >= MAX_TERMINAL_FONT_SIZE}
                discoverabilityLabel="Increase terminal text size"
                onPress={handleIncreaseFontSize}
              >
                <NativeHeaderToolbar.Label>{`A+ ${Math.min(MAX_TERMINAL_FONT_SIZE, fontSize + TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`}</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
            </NativeHeaderToolbar.Menu>
            {terminalMenuSessions.map((session) => (
              <NativeHeaderToolbar.MenuAction
                key={session.terminalId}
                icon={session.terminalId === terminalId ? "checkmark" : "terminal"}
                onPress={() => handleSelectTerminal(session.terminalId)}
                subtitle={[
                  getTerminalStatusLabel({ status: session.status }),
                  basename(session.cwd),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                <NativeHeaderToolbar.Label>{session.displayLabel}</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
            ))}
            <NativeHeaderToolbar.MenuAction
              icon="plus"
              onPress={handleOpenNewTerminal}
              subtitle={`Start another shell in ${basename(selectedThreadProject.workspaceRoot) ?? "this workspace"}`}
            >
              <NativeHeaderToolbar.Label>Open new terminal</NativeHeaderToolbar.Label>
            </NativeHeaderToolbar.MenuAction>
          </NativeHeaderToolbar.Menu>
        </NativeHeaderToolbar>
      ) : null}

      <View className="flex-1" style={{ backgroundColor: terminalTheme.background }}>
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
        ) : (
          <>
            <View className="flex-1" style={{ paddingBottom: terminalBottomInset }}>
              <TerminalSurface
                buffer={terminalSurfaceBuffer}
                fontSize={fontSize}
                isRunning={isRunning}
                keyboardFocusRequest={keyboardFocusRequest}
                onInput={handleInput}
                onResize={handleResize}
                style={{ flex: 1 }}
                terminalKey={terminalKey}
              />
            </View>

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
            ) : !keyboardState.isVisible ? (
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
    </>
  );
}
