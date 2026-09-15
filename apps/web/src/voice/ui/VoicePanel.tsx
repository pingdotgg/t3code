/**
 * The voice entry point: mounts the T3 live client (mic capture, speaker
 * playback, transcripts, acknowledged navigation) inside the chat surface.
 *
 * The overlay is a small corner button by default; clicking it expands the
 * full panel, and both are draggable anywhere in the window (position
 * persisted device-locally). While a live session runs, the expanded panel
 * collapses back to the button after a quiet period (no transcript deltas,
 * tool marks, or state changes).
 *
 * Entry-point gating follows the frozen R3 decision: the overlay renders only
 * when some connected environment is voice-capable and this session holds
 * orchestration:operate there (session creation incurs charges); otherwise
 * it renders nothing at all.
 *
 * Performance notes: state updates are event-driven only (client events,
 * atom changes) — no polling loops beyond the 1 Hz auto-collapse check while
 * expanded and live, no per-frame work, no animations.
 */
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { readThreadShells } from "../../state/entities";
import { createWebVoiceToolHost } from "../tools";
import { createCommandSession, type CommandActions } from "../command-session";

import type { VoiceLiveMediaStreamTrack } from "../live-client";
import { createVoiceHistoryRecorder, exportVoiceHistory } from "../history";
import { createVoiceModule } from "../index";
import { useVoiceOverlayPreferences, type VoiceOverlayPosition } from "./overlayPreferences";
import { useVoiceFastCommands } from "./preferences";
import { VoiceControls } from "./VoiceControls";
import { createActionChime } from "./actionChime";
import { VoiceHistory } from "./VoiceHistory";
import { VoiceTranscript } from "./VoiceTranscript";
import {
  clampVoiceOverlayPosition,
  shouldAutoCollapseVoiceOverlay,
  VOICE_DRAG_THRESHOLD_PX,
  VOICE_HOLD_MS,
} from "./voiceOverlayLayout";
import {
  captureWebMic,
  environmentReachability,
  resolveWebVoiceBrokerPort,
  useVoiceRouteDriver,
  voiceBrokerSelectionAtom,
} from "./useVoiceRuntime";
import { createVoicePanelController, type VoiceMicController } from "./voicePanelController";
import { useDragGesture } from "./useDragGesture";

function attachTrackToAudioElement(
  element: HTMLAudioElement,
  track: VoiceLiveMediaStreamTrack,
): void {
  element.srcObject = new MediaStream([track as unknown as MediaStreamTrack]);
}

const PHASE_DOT_CLASSES: Record<string, string> = {
  idle: "bg-muted-foreground/40",
  connecting: "bg-amber-500",
  live: "bg-emerald-500",
  closing: "bg-amber-500",
  closed: "bg-muted-foreground/40",
  error: "bg-red-500",
};

const sessionInactivePhase = (phase: string) =>
  phase === "idle" || phase === "closed" || phase === "error";

export function VoicePanel() {
  const [testText, setTestText] = useState("");
  const [chime] = useState(createActionChime);
  const [fastCommands, setFastCommands] = useVoiceFastCommands();
  const [prefs, setPrefs] = useVoiceOverlayPreferences();
  const newThread = useHandleNewThread();
  const actionsRef = useRef<CommandActions>(null!);
  const fastRef = useRef(false);
  fastRef.current = fastCommands;
  const [commandHost] = useState(createWebVoiceToolHost);
  const currentThread = newThread.activeThread ?? newThread.activeDraftThread;
  const projectRef = currentThread
    ? scopeProjectRef(currentThread.environmentId, currentThread.projectId)
    : newThread.defaultProjectRef;
  actionsRef.current = {
    threads: () => {
      const allowed = new Set(
        commandHost
          .catalogEnvironments()
          .filter(
            (entry) =>
              entry.connectionState === "connected" &&
              entry.scopes.includes(AuthOrchestrationReadScope),
          )
          .map((entry) => entry.environmentId),
      );
      return readThreadShells()
        .filter((thread) => thread.archivedAt === null && allowed.has(thread.environmentId))
        .map((thread) => ({
          id: thread.id,
          environmentId: thread.environmentId,
          title: thread.title,
        }));
    },
    openDraft: () => (projectRef ? newThread.handleNewThread(projectRef) : Promise.resolve(null)),
    context: () =>
      JSON.stringify({
        project: projectRef,
        currentThread: newThread.activeThread
          ? {
              id: newThread.activeThread.id,
              title: newThread.activeThread.title,
              environmentId: newThread.activeThread.environmentId,
            }
          : null,
        knownThreads: actionsRef.current.threads().slice(0, 30),
      }),
  };
  const selection = useAtomValue(voiceBrokerSelectionAtom);
  const driver = useVoiceRouteDriver();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speechSuppressedRef = useRef(false);
  const suppressSpeech = (suppressed: boolean) => {
    speechSuppressedRef.current = suppressed;
    if (audioRef.current) audioRef.current.muted = suppressed;
  };
  const pendingSpeakerTrack = useRef<VoiceLiveMediaStreamTrack | null>(null);

  const attachSpeakerTrack = useCallback((track: VoiceLiveMediaStreamTrack) => {
    const audio = audioRef.current;
    if (audio === null) {
      pendingSpeakerTrack.current = track;
      return;
    }
    attachTrackToAudioElement(audio, track);
  }, []);

  // The voice module (T7's final wiring) owns the shared tool executor and
  // the research bridge; its createClient re-points the bridge's steering and
  // marks at each new session and re-arms research recovery on reconnect.
  const [voice] = useState(() => createVoiceModule());
  // Durable session history: records the same client event stream the panel
  // displays, plus navigation and tool outcomes, into guarded localStorage.
  const [history] = useState(() =>
    createVoiceHistoryRecorder({
      sessionIdentity: () => {
        const sessionId = voice.boundClient()?.getSessionId();
        return sessionId === undefined ? undefined : `${sessionId}`;
      },
    }),
  );
  const [controller] = useState(() =>
    createVoicePanelController({
      history,
      resolveBrokerPort: resolveWebVoiceBrokerPort,
      captureMic: async () => {
        await chime.unlock().catch(() => undefined);
        return captureWebMic();
      },
      createToolsExecutor: () => voice.executor,
      createClient: (options) =>
        fastRef.current
          ? createCommandSession(
              {
                ...options,
                acknowledgeAction: chime.play,
                onSpeechSuppressionChange: suppressSpeech,
              },
              {
                threads: () => actionsRef.current.threads(),
                openDraft: () => actionsRef.current.openDraft(),
                context: () => actionsRef.current.context(),
              },
              voice.createClient,
            )
          : voice.createClient({
              ...options,
              acknowledgeAction: chime.play,
              onSpeechSuppressionChange: suppressSpeech,
            }),
      driver,
      reachabilityOf: environmentReachability,
      attachSpeakerTrack,
    }),
  );
  const panelState = useSyncExternalStore(controller.subscribe, controller.getState);

  // Saved-history review state: the recorder is an external store whose
  // snapshot refreshes on every boundary write, clear, and delete, so the
  // listing stays current across end, reconnect, and reload with no effects.
  const historySessions = useSyncExternalStore(history.subscribe, history.getSessionsSnapshot);
  const [historyOpen, setHistoryOpen] = useState(false);

  // A reload or tab close must not lose buffered transcript deltas: the
  // recorder persists at boundaries, and pagehide is the last boundary.
  useEffect(() => {
    const onHide = () => history.flush();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [history]);

  // Broker environment lost mid-session (disconnect, capability flag or
  // operate scope gone): end through the same close lifecycle (mic stop,
  // session.close, broker close accounting) before the overlay hides, so the
  // user sees a readable ended state instead of a silent vanish. Safe when
  // nothing is live (end is a no-op then).
  const selectionOk = selection.status === "ok";
  useEffect(() => {
    if (!selectionOk) {
      void controller.end();
    }
  }, [selectionOk, controller]);

  // Unmount cleanup: stop the microphone, close the live session through the
  // existing close lifecycle (broker close accounting included), and dispose
  // the observers (research bridge, mark/transcript subscriptions, the
  // late-redirect watch). Both dispose methods are idempotent and reversible
  // by explicit use, so React StrictMode's simulated unmount (cleanup while
  // component state is preserved) leaves the remounted panel working; a real
  // unmount never uses the instances again. A pending connect whose mic
  // capture or mint is still in flight is suppressed by the controller's
  // disposed guards and acquires nothing.
  useEffect(() => {
    return () => {
      controller.dispose();
      voice.dispose();
      chime.close();
    };
  }, [controller, voice, chime]);

  const setAudioElement = useCallback((element: HTMLAudioElement | null) => {
    audioRef.current = element;
    if (element) element.muted = speechSuppressedRef.current;
    const track = pendingSpeakerTrack.current;
    if (element !== null && track !== null) {
      attachTrackToAudioElement(element, track);
      pendingSpeakerTrack.current = null;
    }
  }, []);

  // -----------------------------------------------------------------------
  // Overlay placement and dragging
  // -----------------------------------------------------------------------

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [dragPos, setDragPos] = useState<VoiceOverlayPosition | null>(null);
  const livePosRef = useRef<VoiceOverlayPosition | null>(null);

  const clampToViewport = useCallback((position: VoiceOverlayPosition): VoiceOverlayPosition => {
    const element = overlayRef.current;
    return clampVoiceOverlayPosition(
      position,
      { width: element?.offsetWidth ?? 0, height: element?.offsetHeight ?? 0 },
      window.innerWidth,
      window.innerHeight,
    );
  }, []);

  const dragBaseRef = useRef<VoiceOverlayPosition | null>(null);
  const dragEndedMovedRef = useRef(false);
  const dragHandlers = useDragGesture({
    threshold: VOICE_DRAG_THRESHOLD_PX,
    onDragStart: () => {
      cancelHoldPress();
      const element = overlayRef.current;
      const rect = element?.getBoundingClientRect();
      dragBaseRef.current =
        livePosRef.current ?? (rect ? { x: rect.left, y: rect.top } : { x: 0, y: 0 });
    },
    onDragMove: (dx, dy) => {
      const base = dragBaseRef.current;
      if (base === null) return;
      const next = clampToViewport({ x: base.x + dx, y: base.y + dy });
      livePosRef.current = next;
      setDragPos(next);
    },
    onDragEnd: (moved) => {
      dragEndedMovedRef.current = moved;
      dragBaseRef.current = null;
      if (moved && livePosRef.current !== null) {
        setPrefs({ position: livePosRef.current });
        setDragPos(null);
      }
    },
  });

  // A stored position can fall outside the viewport after a resize or a
  // collapse/expand size change: re-clamp it against the rendered element.
  useEffect(() => {
    const stored = prefs.position;
    if (stored === null || dragPos !== null) return;
    const element = overlayRef.current;
    if (element === null) return;
    const clamped = clampVoiceOverlayPosition(
      stored,
      { width: element.offsetWidth, height: element.offsetHeight },
      window.innerWidth,
      window.innerHeight,
    );
    if (clamped.x !== stored.x || clamped.y !== stored.y) {
      setPrefs({ position: clamped });
    }
  }, [prefs.position, prefs.collapsed, dragPos, setPrefs]);

  const renderedPosition = dragPos ?? prefs.position;

  // -----------------------------------------------------------------------
  // Activation modes (device-local preference)
  // -----------------------------------------------------------------------

  // Latest runtime values for timer callbacks without re-arming them on
  // every state emit.
  const runtimeRef = useRef({
    phase: panelState.phase,
    starting: panelState.starting,
    inFlightTool: panelState.inFlightTool,
    lastActivityAt: panelState.lastActivityAt,
    activation: prefs.activation,
  });
  runtimeRef.current = {
    phase: panelState.phase,
    starting: panelState.starting,
    inFlightTool: panelState.inFlightTool,
    lastActivityAt: panelState.lastActivityAt,
    activation: prefs.activation,
  };

  const toggleTalk = useCallback(() => {
    const runtime = runtimeRef.current;
    if (runtime.starting) return;
    if (sessionInactivePhase(runtime.phase)) {
      void controller.connect();
    } else {
      void controller.end();
    }
  }, [controller]);

  // A manual expand counts as auto-collapse activity: the user asked to read
  // the panel, so the quiet timer restarts from that moment.
  const expandedAtRef = useRef(0);
  const expandOverlay = useCallback(() => {
    expandedAtRef.current = Date.now();
    setPrefs({ collapsed: false });
  }, [setPrefs]);

  // Hold-to-talk on the corner button: a press held past the hold threshold
  // starts the session; release ends it. A shorter press is a tap (expand);
  // a drag cancels the hold entirely.
  const holdTimerRef = useRef<number | null>(null);
  const holdStartedRef = useRef(false);
  const cancelHoldPress = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const beginHoldPress = useCallback(() => {
    cancelHoldPress();
    holdStartedRef.current = false;
    const runtime = runtimeRef.current;
    if (runtime.activation !== "hold" || runtime.starting) return;
    if (!sessionInactivePhase(runtime.phase)) return;
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      holdStartedRef.current = true;
      void controller.connect();
    }, VOICE_HOLD_MS);
  }, [cancelHoldPress, controller]);

  const endHoldPress = useCallback(() => {
    cancelHoldPress();
    if (!holdStartedRef.current) return false;
    holdStartedRef.current = false;
    void controller.end();
    return true;
  }, [cancelHoldPress, controller]);

  useEffect(() => {
    return () => {
      cancelHoldPress();
    };
  }, [cancelHoldPress]);

  // Double-press on the corner button: the second click inside the native
  // double-click window toggles listening; a lone click expands the panel
  // after the window passes (a first click must not unmount the button
  // before the second one lands on it).
  const expandTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const cancelExpandTimer = useCallback(() => {
    if (expandTimerRef.current !== null) {
      window.clearTimeout(expandTimerRef.current);
      expandTimerRef.current = null;
    }
  }, []);
  useEffect(() => {
    return () => {
      cancelExpandTimer();
    };
  }, [cancelExpandTimer]);

  const cornerButtonClick = useCallback(
    (event: React.MouseEvent) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      if (prefs.activation === "double-press") {
        if (event.detail > 1) {
          cancelExpandTimer();
          toggleTalk();
        } else if (event.detail === 1) {
          cancelExpandTimer();
          expandTimerRef.current = window.setTimeout(() => {
            expandTimerRef.current = null;
            expandOverlay();
          }, 250);
        }
        return;
      }
      if (prefs.collapsed) {
        expandOverlay();
      } else {
        setPrefs({ collapsed: true });
      }
    },
    [prefs.activation, prefs.collapsed, setPrefs, toggleTalk, cancelExpandTimer, expandOverlay],
  );

  // Always listening: connect whenever the session is dormant, stay connected
  // through drops, and stop only after an explicit End or an error (repeated
  // failed reconnects would be worse than silence). A manual connect or an
  // activation-mode change re-arms it.
  const userStoppedRef = useRef(false);
  useEffect(() => {
    userStoppedRef.current = false;
  }, [prefs.activation]);
  useEffect(() => {
    if (panelState.phase === "error") {
      userStoppedRef.current = true;
    }
  }, [panelState.phase]);
  useEffect(() => {
    if (!selectionOk || prefs.activation !== "always" || userStoppedRef.current) return;
    if (!sessionInactivePhase(panelState.phase) || panelState.starting) return;
    void controller.connect();
  }, [selectionOk, prefs.activation, panelState.phase, panelState.starting, controller]);

  // -----------------------------------------------------------------------
  // Auto-collapse on silence
  // -----------------------------------------------------------------------

  const collapsed = prefs.collapsed;
  useEffect(() => {
    if (collapsed || panelState.phase !== "live") return;
    const id = window.setInterval(() => {
      const runtime = runtimeRef.current;
      if (
        shouldAutoCollapseVoiceOverlay({
          expanded: true,
          phase: runtime.phase,
          inFlightTool: runtime.inFlightTool,
          lastActivityAt: Math.max(runtime.lastActivityAt, expandedAtRef.current),
          now: Date.now(),
        })
      ) {
        setPrefs({ collapsed: true });
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [collapsed, panelState.phase, setPrefs]);

  if (selection.status !== "ok") {
    return null;
  }

  const positionStyle = renderedPosition
    ? { left: renderedPosition.x, top: renderedPosition.y }
    : undefined;
  const positionClasses = renderedPosition ? "" : "right-4 bottom-4";

  const cornerButton = (
    <div
      ref={overlayRef}
      data-voice-panel=""
      className={`fixed z-50 ${positionClasses}`}
      style={positionStyle}
    >
      <button
        type="button"
        aria-label={`Voice, ${panelState.phase}`}
        data-voice-phase={panelState.phase}
        className="flex cursor-grab items-center gap-1.5 rounded-full border bg-background px-3 py-2 text-xs font-medium shadow-lg select-none active:cursor-grabbing"
        // Draggable, tap-to-expand, plus hold-to-talk and double-press in
        // those activation modes (see the handlers above).
        onPointerDown={(event) => {
          dragEndedMovedRef.current = false;
          suppressClickRef.current = false;
          beginHoldPress();
          dragHandlers.onPointerDown(event);
        }}
        onPointerMove={dragHandlers.onPointerMove}
        onPointerUp={(event) => {
          // A released push-to-talk hold (or a drag) must not also register
          // as the click that expands the panel.
          if (endHoldPress() || dragEndedMovedRef.current) {
            suppressClickRef.current = true;
          }
          dragHandlers.onPointerUp(event);
        }}
        onPointerCancel={(event) => {
          cancelHoldPress();
          dragHandlers.onPointerCancel(event);
        }}
        onClick={cornerButtonClick}
      >
        <span
          className={`inline-block h-2 w-2 rounded-full ${PHASE_DOT_CLASSES[panelState.phase] ?? PHASE_DOT_CLASSES.idle}`}
        />
        Voice
      </button>
    </div>
  );

  if (collapsed) {
    return (
      <>
        {cornerButton}
        <audio ref={setAudioElement} autoPlay className="hidden" />
      </>
    );
  }

  return (
    <>
      <div
        ref={overlayRef}
        className={`fixed z-50 flex w-80 flex-col gap-2 rounded-xl border bg-background p-3 text-sm shadow-lg ${positionClasses}`}
        style={positionStyle}
        data-voice-panel=""
      >
        <div
          className="flex cursor-grab items-center justify-between select-none active:cursor-grabbing"
          {...dragHandlers}
        >
          <span className="text-xs font-semibold text-muted-foreground">
            Voice ({selection.label})
          </span>
          <button
            type="button"
            aria-label="Minimize voice"
            className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setPrefs({ collapsed: true })}
          >
            Minimize
          </button>
        </div>
        <VoiceControls
          phase={panelState.phase}
          starting={panelState.starting}
          micMuted={panelState.micMuted}
          activation={prefs.activation}
          onConnect={() => void controller.connect()}
          onTalkPress={() => void controller.connect()}
          onTalkRelease={() => void controller.end()}
          onTalkToggle={toggleTalk}
          onToggleMute={() => controller.toggleMute()}
          onEnd={() => {
            if (prefs.activation === "always") userStoppedRef.current = true;
            void controller.end();
          }}
          onClear={() => controller.clear()}
        />
        <VoiceTranscript
          utterances={panelState.utterances}
          inFlightTool={panelState.inFlightTool}
          error={panelState.error}
          navigationStatus={panelState.navigationStatus}
          navigationFailed={panelState.navigationFailed}
        />
        <VoiceHistory
          sessions={historySessions}
          open={historyOpen}
          onToggle={() => setHistoryOpen(!historyOpen)}
          frozen={
            panelState.phase === "live" ||
            panelState.phase === "connecting" ||
            panelState.phase === "closing"
          }
          onExport={() => {
            const json = exportVoiceHistory(history);
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `voice-history-${new Date().toISOString()}.json`;
            anchor.click();
            URL.revokeObjectURL(url);
          }}
          onClear={() => {
            history.clear();
          }}
          onDelete={(id) => {
            history.deleteSession(id);
          }}
        />
        <label>
          <input
            type="checkbox"
            aria-label="Try fast commands"
            checked={fastCommands}
            disabled={
              panelState.starting ||
              panelState.phase === "live" ||
              panelState.phase === "connecting" ||
              panelState.phase === "closing"
            }
            onChange={(event) => setFastCommands(event.target.checked)}
          />
          Try fast commands
        </label>
        {import.meta.env.DEV && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (controller.sendText(testText)) setTestText("");
            }}
          >
            <input
              aria-label="Live test text"
              value={testText}
              onChange={(event) => setTestText(event.target.value)}
            />
            <button type="submit" disabled={panelState.phase !== "live" || !testText.trim()}>
              Send test text
            </button>
          </form>
        )}
      </div>
      <audio ref={setAudioElement} autoPlay className="hidden" />
    </>
  );
}

export type { VoiceMicController };
