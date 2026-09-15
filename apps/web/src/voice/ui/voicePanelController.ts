/**
 * Pure controller behind the voice panel UI (the components stay dumb). Owns
 * the voice session lifecycle (connect via mic capture + broker port + live
 * client start, mute, end, clear), folds client events into display state
 * (session phase, transcripts, in-flight tool indicator, errors), and wires
 * the navigator (acknowledged navigation + first_useful_speech) into the
 * tool executor bridge.
 *
 * No React, no DOM, no timers beyond the navigator's injected redirect
 * watch: every browser boundary is injected, so behavior tests run in plain
 * Node. The panel component subscribes via useSyncExternalStore.
 */
import type { VoiceToolError } from "@t3tools/contracts";

import {
  createVoiceLiveClient,
  defaultPeerConnectionFactory,
  type VoiceLiveBrokerPort,
  type VoiceLiveClient,
  type VoiceLiveClientEvent,
  type VoiceLiveClientOptions,
  type VoiceLiveMediaStreamTrack,
  type VoiceLiveSessionState,
} from "../live-client";
import type { VoiceHistoryRecorder } from "../history";
import {
  createVoiceNavigator,
  type VoiceNavigationDestination,
  type VoiceNavigationResult,
  type VoiceNavigatorDeps,
  type VoiceRouteDriver,
} from "../navigation";
import type { VoiceToolExecutor } from "../tools";
import { createNavigatingVoiceToolExecutor } from "./toolBridge";

/** Session phase for display: the live client's state machine, with the
    pre-client mic/mint work folded into "connecting". */
export type VoicePanelPhase = "idle" | "connecting" | "live" | "closing" | "closed" | "error";

/** One ordered chat entry in the voice panel: a speaker-labeled utterance
    accumulated from the live client's transcript deltas. The client assigns
    the stable `utterance` key per boundary (channel flip, delegation);
    consecutive deltas sharing the key append to the same entry. */
export interface VoiceUtterance {
  readonly id: string;
  readonly channel: "input" | "output";
  readonly text: string;
}

/** Upper bound on retained utterances; the panel shows the latest window and
    the transcript cannot grow without bound across a long session. */
const MAX_UTTERANCES = 200;

export interface VoicePanelState {
  readonly phase: VoicePanelPhase;
  /** True from connect() until the client exists (mic capture + broker port
      resolution); connect stays disabled while this is set. */
  readonly starting: boolean;
  readonly micMuted: boolean;
  readonly error: VoiceToolError | null;
  /** Ordered chat utterances, oldest first, speaker-labeled by channel. */
  readonly utterances: ReadonlyArray<VoiceUtterance>;
  /** Tool name while delegated backend work is in flight (drives the
      visible work indicator so interruption + correction stays usable). */
  readonly inFlightTool: string | null;
  readonly navigationStatus: string | null;
  readonly navigationFailed: boolean;
}

/** The captured microphone boundary. Muting toggles the track's enabled
    flag (the transport keeps flowing; Live just hears silence). */
export interface VoiceMicController {
  readonly track: VoiceLiveMediaStreamTrack & { readonly enabled: boolean };
  setMuted(muted: boolean): void;
  stop(): void;
}

export interface VoicePanelControllerDeps {
  readonly resolveBrokerPort: () => Promise<VoiceLiveBrokerPort>;
  readonly captureMic: () => Promise<VoiceMicController>;
  /** T2/T5's per-tool executor over the web client's authenticated machinery. */
  readonly createToolsExecutor: () => VoiceToolExecutor;
  readonly driver: VoiceRouteDriver;
  readonly reachabilityOf: VoiceNavigatorDeps["reachabilityOf"];
  /** Attaches the client's speaker track to playback (the audio element). */
  readonly attachSpeakerTrack: (track: VoiceLiveMediaStreamTrack) => void;
  /** Live client factory; tests inject a fake, production uses
      `createVoiceLiveClient` with the real peer connection factory. */
  readonly createClient?: (options: VoiceLiveClientOptions) => VoiceLiveClient;
  /** Navigation outcomes are recorded for display; failures surface here. */
  readonly now?: () => number;
  /** Durable history recorder; absent disables history recording (tests). */
  readonly history?: VoiceHistoryRecorder;
}

export interface VoicePanelController {
  getState(): VoicePanelState;
  subscribe(listener: () => void): () => void;
  connect(): Promise<void>;
  toggleMute(): void;
  sendText(text: string): boolean;
  end(): Promise<void>;
  /** Clears transcripts, error, and navigation display; usable when idle or
      after a session has ended. */
  clear(): void;
  dispose(): void;
}

const clientPhaseToPanelPhase = (state: VoiceLiveSessionState): VoicePanelPhase => {
  switch (state) {
    case "idle":
    case "minting":
    case "connecting":
      return "connecting";
    case "live":
      return "live";
    case "closing":
      return "closing";
    case "closed":
      return "closed";
    case "error":
      return "error";
  }
};

export function createVoicePanelController(deps: VoicePanelControllerDeps): VoicePanelController {
  const listeners = new Set<() => void>();
  let client: VoiceLiveClient | undefined;
  let mic: VoiceMicController | undefined;
  let unsubscribeClient: (() => void) | undefined;
  /** Disposal releases every resource (mic, session through the existing
      close lifecycle, observers). It is reversible by explicit use: React
      StrictMode's simulated unmount runs cleanup while keeping the component
      state, so a remounted panel re-subscribes to the same controller and the
      next connect() re-arms it. A real unmount never uses it again. */
  let disposed = false;
  /** Per-attempt cancellation token. Each connect() captures its epoch;
      end() and dispose() bump it, so a resumed await from an older attempt is
      always stale — including after dispose→revive, where the reversible
      `disposed` boolean alone could not distinguish an old attempt's resumed
      await from a newer connection. */
  let attemptEpoch = 0;

  type MutableVoicePanelState = {
    -readonly [K in keyof VoicePanelState]: VoicePanelState[K];
  };
  const state: MutableVoicePanelState = {
    phase: "idle",
    starting: false,
    micMuted: false,
    error: null,
    utterances: [],
    inFlightTool: null,
    navigationStatus: null,
    navigationFailed: false,
  };

  /** Immutable snapshot for useSyncExternalStore: identity changes on every
      emit so React re-renders; the internal record stays mutable. */
  let snapshot: VoicePanelState = { ...state };

  const emitChange = () => {
    snapshot = { ...state };
    for (const listener of listeners) {
      listener();
    }
  };

  const setPhase = (phase: VoicePanelPhase) => {
    if (state.phase !== phase) {
      state.phase = phase;
      emitChange();
    }
  };

  const recordNavigation = (
    result: VoiceNavigationResult,
    destination: VoiceNavigationDestination,
  ) => {
    deps.history?.recordNavigation(result, destination);
    if (result.status === "acknowledged") {
      state.navigationStatus = `Opened thread ${destination.threadId}.`;
      state.navigationFailed = false;
    } else if (result.status === "failed") {
      state.navigationStatus = describeVoiceToolError(result.error);
      state.navigationFailed = true;
    }
    emitChange();
  };

  const navigator = createVoiceNavigator({
    driver: deps.driver,
    reachabilityOf: deps.reachabilityOf,
    emitMark: (mark, detail) => client?.emitMark(mark, detail),
    onRedirectAfterAcknowledgment: (error) => {
      state.navigationStatus = describeVoiceToolError(error);
      state.navigationFailed = true;
      emitChange();
    },
  });

  const handleEvent = (event: VoiceLiveClientEvent) => {
    // History records the same event stream the panel displays, before the
    // disposed guard: close-time events still belong in the record.
    deps.history?.record(event);
    if (disposed) {
      // Late events after disposal apply no state.
      return;
    }
    switch (event.type) {
      case "command_result":
        state.navigationStatus = event.text;
        state.navigationFailed = false;
        emitChange();
        break;
      case "state": {
        setPhase(clientPhaseToPanelPhase(event.state));
        break;
      }
      case "transcript": {
        // Late or interleaved deltas fold by the client-assigned utterance
        // key: the matching entry appends in place (keeping its position so
        // the reading order stays stable), a new key opens a new entry in
        // arrival order.
        const key = `${event.channel}:${event.utterance}`;
        const index = state.utterances.findIndex((utterance) => utterance.id === key);
        if (index >= 0) {
          const existing = state.utterances[index]!;
          state.utterances = state.utterances.with(index, {
            ...existing,
            text: existing.text + event.delta,
          });
        } else {
          state.utterances = [
            ...state.utterances,
            { id: key, channel: event.channel, text: event.delta },
          ];
          if (state.utterances.length > MAX_UTTERANCES) {
            state.utterances = state.utterances.slice(state.utterances.length - MAX_UTTERANCES);
          }
        }
        if (event.channel === "output") {
          // The model is speaking usefully after a navigation: mark it once.
          navigator.onOutputTranscriptDelta();
        }
        emitChange();
        break;
      }
      case "timing": {
        if (event.record.mark === "function_call_received") {
          state.inFlightTool = event.record.detail ?? null;
          emitChange();
        } else if (
          event.record.mark === "tool_done" ||
          event.record.mark === "function_call_output_sent"
        ) {
          if (state.inFlightTool !== null) {
            state.inFlightTool = null;
            emitChange();
          }
        }
        break;
      }
      case "track": {
        deps.attachSpeakerTrack(event.track);
        break;
      }
      case "error": {
        state.error = event.error;
        emitChange();
        break;
      }
      case "usage":
        break;
    }
  };

  const connect = async (): Promise<void> => {
    if (
      state.starting ||
      (state.phase !== "idle" && state.phase !== "closed" && state.phase !== "error")
    ) {
      return;
    }
    // Explicit use after disposal revives the controller (the
    // StrictMode-remount path); resources are only acquired below.
    disposed = false;
    // This attempt's token: end() and dispose() bump the epoch, so every
    // stale() check below rejects a resumed await from this attempt after
    // invalidation — including invalidation followed by revival, where the
    // reversible `disposed` flag alone cannot tell an old attempt from a new
    // connection.
    const epoch = ++attemptEpoch;
    const stale = () => disposed || epoch !== attemptEpoch;
    // The attempt's own resource references: cleanup touches only what this
    // attempt acquired, never a newer attempt's assignments.
    let myMic: VoiceMicController | undefined;
    state.starting = true;
    state.error = null;
    state.navigationStatus = null;
    state.navigationFailed = false;
    state.utterances = [];
    state.inFlightTool = null;
    deps.history?.beginSession();
    emitChange();
    try {
      myMic = mic = await deps.captureMic();
      if (stale()) {
        // Invalidated while the capture was pending: release what arrived,
        // acquire nothing.
        myMic.stop();
        if (mic === myMic) {
          mic = undefined;
        }
        return;
      }
      const brokerPort = await deps.resolveBrokerPort();
      if (stale()) {
        // Invalidated while the resolution was pending: the mic was already
        // released by the invalidating end()/dispose().
        return;
      }
      const navigatingExecutor = createNavigatingVoiceToolExecutor({
        tools: deps.createToolsExecutor(),
        navigator: {
          navigateToThread: async (destination) => {
            const result = await navigator.navigateToThread(destination);
            recordNavigation(result, destination);
            return result;
          },
        },
      });
      const options: VoiceLiveClientOptions = {
        broker: brokerPort,
        createPeerConnection: defaultPeerConnectionFactory,
        executor: deps.history
          ? {
              execute: (name, input) =>
                deps.history!.recordToolExecution(name, input, () =>
                  navigatingExecutor.execute(name, input),
                ),
            }
          : navigatingExecutor,
        ...(myMic !== undefined ? { audioTrack: myMic.track } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      };
      const myClient = (deps.createClient ?? createVoiceLiveClient)(options);
      client = myClient;
      unsubscribeClient?.();
      unsubscribeClient = myClient.onEvent(handleEvent);
      if (stale()) {
        // Invalidated between creation and start: run the existing close
        // lifecycle (session.close, session.closed, broker accounting).
        await myClient.close();
        return;
      }
      await myClient.start();
      if (stale()) {
        // Invalidated during the start: end()/dispose() already ran the
        // lifecycle for this client (close is idempotent on the client).
        return;
      }
    } catch (cause) {
      if (stale()) {
        // A late failure after invalidation applies no state and keeps no
        // resources.
        myMic?.stop();
        if (mic === myMic) {
          mic = undefined;
        }
        return;
      }
      state.error = toVoiceToolError(cause);
      setPhase("error");
      mic?.stop();
      mic = undefined;
    } finally {
      state.starting = false;
      if (!stale()) {
        emitChange();
      }
    }
  };

  const toggleMute = (): void => {
    if (mic === undefined) {
      return;
    }
    const muted = !state.micMuted;
    mic.setMuted(muted);
    state.micMuted = muted;
    emitChange();
  };

  const end = async (): Promise<void> => {
    // Invalidate any in-flight connect attempt: its resumed awaits observe
    // the epoch bump and release without establishing a session the user
    // ended. This makes End the cancel button for a pending connection,
    // including the initial idle-starting state before a client exists.
    attemptEpoch += 1;
    // The session record ends here even when no client exists to emit the
    // closed state (cancel of a pending connection).
    deps.history?.endSession();
    if (disposed) {
      return;
    }
    const currentClient = client;
    const currentMic = mic;
    mic = undefined;
    currentMic?.stop();
    state.micMuted = false;
    // The invalidated attempt's connect() finally skips its emit (stale), so
    // end() settles the display itself: no stuck "Starting…", Connect
    // re-enabled, a readable non-live phase — never a silent vanish.
    state.starting = false;
    if (currentClient === undefined) {
      setPhase("idle");
      emitChange();
      return;
    }
    await currentClient.close();
    // The close lifecycle emits its own closed state; this emit makes the
    // `starting` settling visible even when the stale attempt's finally
    // skips it.
    emitChange();
  };

  const clear = (): void => {
    state.error = null;
    state.utterances = [];
    state.inFlightTool = null;
    state.navigationStatus = null;
    state.navigationFailed = false;
    emitChange();
  };

  const dispose = (): void => {
    if (disposed) {
      // Idempotent: a second dispose (or StrictMode's double cleanup) is a
      // no-op.
      return;
    }
    disposed = true;
    // Invalidate any in-flight connect attempt; after a revival it must stay
    // stale even though `disposed` flips back to false.
    attemptEpoch += 1;
    // The close lifecycle below is observed through a detached subscription,
    // so the history record ends explicitly here.
    deps.history?.endSession();
    navigator.dispose();
    unsubscribeClient?.();
    unsubscribeClient = undefined;
    mic?.stop();
    mic = undefined;
    state.micMuted = false;
    state.starting = false;
    const currentClient = client;
    client = undefined;
    if (currentClient !== undefined) {
      // Unmount cannot await: run the existing close lifecycle (session.close,
      // wait for session.closed, broker close accounting) without blocking.
      // Late client events apply no state (handleEvent checks disposed, and
      // the subscription above is detached).
      void currentClient.close().catch(() => {});
      // A readable ended state, never a silent vanish.
      if (state.phase === "live" || state.phase === "connecting" || state.phase === "closing") {
        state.phase = "closed";
      }
    }
    emitChange();
    listeners.clear();
  };

  return {
    sendText: (text) => client?.sendText?.(text) ?? false,
    getState: () => snapshot,
    subscribe: (listener) => {
      // (Re-)subscribing after disposal revives the display shell (the
      // StrictMode-remount path); resources stay released until connect().
      disposed = false;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect,
    toggleMute,
    end,
    clear,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Error display
// ---------------------------------------------------------------------------

const ERROR_CODE_LABELS: Record<VoiceToolError["code"], string> = {
  insufficient_scope: "This session lacks the permission needed for that.",
  auth_invalid: "The session was revoked or is invalid; sign in again.",
  environment_unreachable: "That environment could not be reached.",
  environment_not_in_catalog: "That environment is not connected to this client.",
  project_not_found: "That project does not exist.",
  thread_not_found: "That thread could not be opened; it may have been deleted.",
  model_unavailable: "That model is not available on the target environment.",
  query_invalid: "That search request was not valid.",
  partial_failure: "Part of the request failed.",
  invalid_request: "The request was not valid.",
};

/** Human-readable rendering of a frozen voice error; the raw message is kept
    because it carries the concrete subject (which thread, which environment). */
export function describeVoiceToolError(error: VoiceToolError): string {
  return `${ERROR_CODE_LABELS[error.code]} (${error.message})`;
}

function toVoiceToolError(cause: unknown): VoiceToolError {
  if (
    typeof cause === "object" &&
    cause !== null &&
    typeof (cause as Record<string, unknown>).code === "string" &&
    typeof (cause as Record<string, unknown>).message === "string"
  ) {
    const record = cause as Record<string, unknown>;
    return {
      code: record.code as VoiceToolError["code"],
      message: record.message as string,
    };
  }
  return {
    code: "environment_unreachable",
    message: cause instanceof Error ? cause.message : String(cause),
  };
}
