import { DEFAULT_TERMINAL_ID, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type KnownTerminalSession } from "@t3tools/client-runtime/state/terminal";
import { SymbolView } from "expo-symbols";
import {
  NativeHeaderToolbar,
  NativeStackScreenOptions,
  useRouteParams,
  useAppNavigation,
} from "../../navigation/native-stack-header";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text as RNText, View, useColorScheme } from "react-native";
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
} from "../../components/ComposerToolbarTrigger";
import { EmptyState } from "../../components/EmptyState";
import { GlassSurface } from "../../components/GlassSurface";
import { LoadingScreen } from "../../components/LoadingScreen";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentPresentation } from "../../state/presentation";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceState } from "../../state/workspace";
import { buildThreadTerminalNavigation } from "../../lib/routes";
import { nativeHeaderScrollEdgeEffects } from "../../lib/native-scroll-edge-effect";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
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
import { loadPreferences, savePreferencesPatch } from "../../lib/storage";
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
  resolveTerminalSessionLabel,
  type TerminalMenuSession,
} from "./terminalMenu";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STEP,
  normalizeTerminalFontSize,
} from "./terminalPreferences";
import {
  cacheTerminalFontSize,
  cacheTerminalGridSize,
  getCachedTerminalFontSize,
  getCachedTerminalGridSize,
} from "./terminalUiState";

const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const TERMINAL_ACCESSORY_HEIGHT = 52;
const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

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

function TerminalHeaderTitle(props: {
  readonly topLine: string;
  readonly bottomLine: string;
  readonly foreground: string;
  readonly mutedForeground: string;
}) {
  return (
    <View
      style={{
        alignItems: "center",
        gap: 1,
        maxWidth: 240,
      }}
    >
      <RNText
        numberOfLines={1}
        style={{
          color: props.foreground,
          fontFamily: "DMSans_700Bold",
          fontSize: MOBILE_TYPOGRAPHY.footnote.fontSize,
          lineHeight: 16,
        }}
      >
        {props.topLine}
      </RNText>
      <RNText
        ellipsizeMode="middle"
        numberOfLines={1}
        style={{
          color: props.mutedForeground,
          fontFamily: "Menlo",
          fontSize: MOBILE_TYPOGRAPHY.caption.fontSize,
          lineHeight: 14,
        }}
      >
        {props.bottomLine}
      </RNText>
    </View>
  );
}

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

export function ThreadTerminalRouteScreen() {
  const navigation = useAppNavigation();
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const resizeTerminal = useAtomCommand(terminalEnvironment.resize, "terminal resize");
  const clearTerminal = useAtomCommand(terminalEnvironment.clear, "terminal clear");
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const appearanceScheme = useColorScheme() === "light" ? "light" : "dark";
  const { state: workspaceState } = useWorkspaceState();
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const params = useRouteParams<{
    environmentId?: string | string[];
    threadId?: string | string[];
    terminalId?: string | string[];
  }>();
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
  const cachedFontSize = getCachedTerminalFontSize();
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
  const [fontSize, setFontSize] = useState(cachedFontSize ?? DEFAULT_TERMINAL_FONT_SIZE);
  const [keyboardFocusRequest, setKeyboardFocusRequest] = useState(0);
  const [isAccessoryDismissed, setIsAccessoryDismissed] = useState(false);
  const bufferReplayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstNonEmptyBufferLoggedRef = useRef(false);
  const lastBufferReplayKeyRef = useRef<string | null>(null);
  const sentInitialInputKeyRef = useRef<string | null>(null);
  const [readyBufferReplayKey, setReadyBufferReplayKey] = useState<string | null>(null);
  const [hasResolvedFontPreference, setHasResolvedFontPreference] = useState(
    cachedFontSize !== null,
  );
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
  const headerTitle = useMemo(() => {
    const topLineParts = [
      selectedEnvironmentConnection?.environmentLabel ?? null,
      selectedThreadProject?.title ?? null,
    ].filter((value): value is string => Boolean(value));

    return {
      topLine: topLineParts.join(" \u00b7 "),
      bottomLine: cwd ?? selectedThreadProject?.workspaceRoot ?? "",
    };
  }, [
    cwd,
    selectedEnvironmentConnection?.environmentLabel,
    selectedThreadProject?.title,
    selectedThreadProject?.workspaceRoot,
  ]);
  const renderTerminalHeaderTitle = useCallback(
    () => (
      <TerminalHeaderTitle
        topLine={headerTitle.topLine}
        bottomLine={headerTitle.bottomLine}
        foreground={terminalTheme.foreground}
        mutedForeground={terminalTheme.mutedForeground}
      />
    ),
    [
      headerTitle.bottomLine,
      headerTitle.topLine,
      terminalTheme.foreground,
      terminalTheme.mutedForeground,
    ],
  );
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
    navigation.replace(
      buildThreadTerminalNavigation(selectedThread, runningSession.target.terminalId),
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

  useEffect(() => {
    let cancelled = false;

    void loadPreferences()
      .then((preferences) => {
        if (cancelled) {
          return;
        }

        setFontSize(cacheTerminalFontSize(preferences.terminalFontSize));
        setHasResolvedFontPreference(true);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setHasResolvedFontPreference(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasResolvedFontPreference) {
      return;
    }

    cacheTerminalFontSize(fontSize);
    void savePreferencesPatch({
      terminalFontSize: normalizeTerminalFontSize(fontSize),
    });
  }, [fontSize, hasResolvedFontPreference]);

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

      navigation.replace(buildThreadTerminalNavigation(selectedThread, nextTerminalId));
    },
    [navigation, selectedThread, terminalId],
  );

  const handleOpenNewTerminal = useCallback(() => {
    if (!selectedThread) {
      return;
    }

    navigation.replace(
      buildThreadTerminalNavigation(
        selectedThread,
        nextOpenTerminalId({
          listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
          activeRouteTerminalId: terminalId,
        }),
      ),
    );
  }, [navigation, selectedThread, terminalId, terminalMenuSessions]);

  const adjustFontSize = useCallback((delta: number) => {
    setTimeout(() => {
      setFontSize((current) => cacheTerminalFontSize(current + delta));
    }, 0);
  }, []);

  const handleDecreaseFontSize = useCallback(() => {
    adjustFontSize(-TERMINAL_FONT_SIZE_STEP);
  }, [adjustFontSize]);

  const handleIncreaseFontSize = useCallback(() => {
    adjustFontSize(TERMINAL_FONT_SIZE_STEP);
  }, [adjustFontSize]);

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
          headerShown: true,
          headerBackButtonDisplayMode: "minimal",
          headerBackTitle: "",
          headerTransparent: usesNativeHeaderGlass,
          headerShadowVisible: false,
          headerStyle: {
            backgroundColor: usesNativeHeaderGlass ? "transparent" : terminalTheme.background,
          },
          headerTintColor: terminalTheme.foreground,
          headerTitleAlign: "center",
          headerTitle: usesNativeHeaderGlass ? headerTitle.topLine : renderTerminalHeaderTitle,
          headerTitleStyle: usesNativeHeaderGlass
            ? {
                fontSize: 17,
                fontWeight: "800",
              }
            : undefined,
          scrollEdgeEffects: usesNativeHeaderGlass ? HEADER_SCROLL_EDGE_EFFECTS : undefined,
          title: headerTitle.topLine,
          unstable_navigationItemStyle: usesNativeHeaderGlass ? "editor" : undefined,
        }}
      />

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

      <View style={{ flex: 1, backgroundColor: terminalTheme.background }}>
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
            <View style={{ flex: 1, paddingBottom: terminalBottomInset }}>
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
                  style={{
                    backgroundColor: terminalTheme.background,
                    borderTopColor: terminalTheme.border,
                    borderTopWidth: 1,
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
