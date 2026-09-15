/**
 * The voice entry point: mounts the T3 live client (mic capture, speaker
 * playback, transcripts, acknowledged navigation) inside the chat surface.
 *
 * Entry-point gating follows the frozen R3 decision: the panel renders only
 * when some connected environment is voice-capable and this session holds
 * orchestration:operate there (session creation incurs charges); otherwise
 * it renders nothing at all.
 *
 * Performance notes: state updates are event-driven only (client events,
 * atom changes) — no polling, no per-frame work, no animations.
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
import { useVoiceFastCommands } from "./preferences";
import { VoiceControls } from "./VoiceControls";
import { createActionChime } from "./actionChime";
import { VoiceHistory } from "./VoiceHistory";
import { VoiceTranscript } from "./VoiceTranscript";
import {
  captureWebMic,
  environmentReachability,
  resolveWebVoiceBrokerPort,
  useVoiceRouteDriver,
  voiceBrokerSelectionAtom,
} from "./useVoiceRuntime";
import { createVoicePanelController, type VoiceMicController } from "./voicePanelController";

function attachTrackToAudioElement(
  element: HTMLAudioElement,
  track: VoiceLiveMediaStreamTrack,
): void {
  element.srcObject = new MediaStream([track as unknown as MediaStreamTrack]);
}

export function VoicePanel() {
  const [testText, setTestText] = useState("");
  const [chime] = useState(createActionChime);
  const [fastCommands, setFastCommands] = useVoiceFastCommands();
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
  // session.close, broker close accounting) before the panel hides, so the
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

  if (selection.status !== "ok") {
    return null;
  }

  return (
    <div
      className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2 rounded-xl border bg-background p-3 text-sm shadow-lg"
      data-voice-panel=""
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground">
          Voice ({selection.label})
        </span>
      </div>
      <VoiceControls
        phase={panelState.phase}
        starting={panelState.starting}
        micMuted={panelState.micMuted}
        onConnect={() => void controller.connect()}
        onToggleMute={() => controller.toggleMute()}
        onEnd={() => void controller.end()}
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
      <audio ref={setAudioElement} autoPlay className="hidden" />
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
  );
}

export type { VoiceMicController };
