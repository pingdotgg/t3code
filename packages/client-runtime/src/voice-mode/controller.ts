// @effect-diagnostics globalTimers:off - WebRTC lifecycle runs on platform callbacks, outside an Effect runtime.
import type { ProviderVoiceSessionEvent, ProviderVoiceTranscriptRole } from "@t3tools/contracts";

/**
 * Voice conversations (Codex realtime voice). The client owns the microphone,
 * speaker, and WebRTC peer; the environment only relays the SDP handshake and
 * captions over `provider.voice.session`. Audio never crosses the T3 socket,
 * so voice works the same locally, over a relay, or through a tunnel.
 *
 * The WebRTC surface is structural so browsers and react-native-webrtc both fit.
 */

export interface VoiceMediaTrack {
  enabled: boolean;
  stop(): void;
}

export interface VoiceMediaStream {
  getTracks(): ReadonlyArray<VoiceMediaTrack>;
  getAudioTracks(): ReadonlyArray<VoiceMediaTrack>;
  /** react-native-webrtc frees the native stream here; browsers have no equivalent. */
  release?(): void;
}

interface VoiceSessionDescription {
  readonly sdp?: string | null | undefined;
}

interface VoiceStatsReport {
  forEach(callback: (stat: { readonly type?: string; readonly kind?: string }) => void): void;
}

export interface VoicePeerConnection {
  readonly connectionState: string;
  addTrack(track: never, stream: never): unknown;
  createDataChannel(label: string, options?: { readonly ordered?: boolean }): unknown;
  createOffer(): Promise<VoiceSessionDescription>;
  setLocalDescription(description: never): Promise<void>;
  setRemoteDescription(description: never): Promise<void>;
  getStats(): Promise<VoiceStatsReport>;
  addEventListener(type: "track" | "connectionstatechange", listener: (event: never) => void): void;
  close(): void;
}

export interface VoiceSessionTarget {
  readonly environmentId: string;
  readonly threadId: string;
}

export interface VoiceSessionHandlers {
  readonly onEvent: (event: ProviderVoiceSessionEvent) => void;
  readonly onError: (message: string) => void;
  readonly onEnd: () => void;
}

export interface VoiceModePlatform {
  readonly createPeerConnection: () => VoicePeerConnection;
  /** Resolves an echo-cancelled microphone stream, prompting for permission if needed. */
  readonly getMicrophone: () => Promise<VoiceMediaStream>;
  /** Plays the assistant's audio. Returns a disposer. */
  readonly playRemoteAudio: (stream: VoiceMediaStream) => () => void;
  /** Opens `provider.voice.session`. Returns a cancel function that ends the conversation. */
  readonly openSession: (
    input: VoiceSessionTarget & { readonly offerSdp: string },
    handlers: VoiceSessionHandlers,
  ) => () => void;
}

export type VoiceModePhase = "idle" | "connecting" | "active";

export interface VoiceCaption {
  readonly role: ProviderVoiceTranscriptRole;
  readonly text: string;
  readonly final: boolean;
}

export interface VoiceModeState {
  readonly phase: VoiceModePhase;
  /** The conversation's thread; kept after it ends so its error or end notice can show there. */
  readonly target: VoiceSessionTarget | null;
  readonly muted: boolean;
  /** Recent captions, oldest first. Ephemeral: they vanish when the conversation ends. */
  readonly captions: ReadonlyArray<VoiceCaption>;
  readonly error: string | null;
  /** Why the last conversation ended when the user did not end it. */
  readonly endedReason: string | null;
}

/** Mic and speaker loudness in 0..1, sampled while a conversation is active. */
export interface VoiceLevels {
  readonly microphone: number;
  readonly speaker: number;
}

const VOICE_CONNECT_TIMEOUT_MS = 20_000;
const LEVEL_SAMPLE_INTERVAL_MS = 100;
const MAX_CAPTIONS = 4;
const MAX_CAPTION_CHARS = 1024;

export const INITIAL_VOICE_MODE_STATE: VoiceModeState = {
  phase: "idle",
  target: null,
  muted: false,
  captions: [],
  error: null,
  endedReason: null,
};

/** Appends a streaming caption delta, continuing the speaker's open caption. */
export function appendVoiceCaption(
  captions: ReadonlyArray<VoiceCaption>,
  role: ProviderVoiceTranscriptRole,
  delta: string,
): ReadonlyArray<VoiceCaption> {
  const openIndex = captions.findLastIndex((caption) => caption.role === role && !caption.final);
  if (openIndex === -1) {
    return [...captions, { role, text: delta.trimStart(), final: false }].slice(-MAX_CAPTIONS);
  }
  const open = captions[openIndex]!;
  const text = (open.text + delta).slice(-MAX_CAPTION_CHARS);
  return captions.map((caption, index) => (index === openIndex ? { ...caption, text } : caption));
}

/** Settles the speaker's open caption with the final transcript text. */
export function finishVoiceCaption(
  captions: ReadonlyArray<VoiceCaption>,
  role: ProviderVoiceTranscriptRole,
  text: string,
): ReadonlyArray<VoiceCaption> {
  const finalText = text.trim().slice(-MAX_CAPTION_CHARS);
  const openIndex = captions.findLastIndex((caption) => caption.role === role && !caption.final);
  if (openIndex === -1) {
    return finalText
      ? [...captions, { role, text: finalText, final: true }].slice(-MAX_CAPTIONS)
      : captions;
  }
  if (!finalText) return captions.filter((_, index) => index !== openIndex);
  return captions.map((caption, index) =>
    index === openIndex ? { role, text: finalText, final: true } : caption,
  );
}

/** User-facing text for why a conversation ended without the user stopping it. */
export function describeVoiceEnd(reason: string): string {
  switch (reason) {
    case "replaced":
      return "Voice conversation moved to another window or device.";
    case "ended":
      return "Voice conversation ended.";
    default:
      return `Voice conversation ended: ${reason.replaceAll("_", " ")}.`;
  }
}

function describeError(cause: unknown): string {
  if (cause && typeof cause === "object" && "name" in cause) {
    const name = String((cause as { name: unknown }).name);
    if (name === "NotAllowedError" || name === "SecurityError") {
      return "Microphone access was denied.";
    }
    if (name === "NotFoundError") return "No microphone was found.";
  }
  if (cause instanceof Error && cause.message) return cause.message;
  return "Voice conversation failed.";
}

interface ActiveSession {
  readonly target: VoiceSessionTarget;
  readonly id: number;
  microphone: VoiceMediaStream | null;
  peer: VoicePeerConnection | null;
  cancelSession: (() => void) | null;
  stopRemoteAudio: (() => void) | null;
  backendStarted: boolean;
  peerConnected: boolean;
  connectTimer: ReturnType<typeof setTimeout> | null;
  levelTimer: ReturnType<typeof setInterval> | null;
  sampling: boolean;
}

/**
 * Owns at most one voice conversation. Starting on another thread ends the
 * current one first, since the microphone is exclusive.
 */
export class VoiceModeController {
  private state: VoiceModeState = INITIAL_VOICE_MODE_STATE;
  private session: ActiveSession | null = null;
  private nextSessionId = 1;
  private readonly listeners = new Set<(state: VoiceModeState) => void>();
  private readonly levelListeners = new Set<(levels: VoiceLevels) => void>();

  private readonly platform: VoiceModePlatform;

  constructor(platform: VoiceModePlatform) {
    this.platform = platform;
  }

  getState = (): VoiceModeState => this.state;

  subscribe = (listener: (state: VoiceModeState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeLevels = (listener: (levels: VoiceLevels) => void): (() => void) => {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  };

  isActiveFor(target: VoiceSessionTarget): boolean {
    const current = this.state.target;
    return (
      this.state.phase !== "idle" &&
      current !== null &&
      current.environmentId === target.environmentId &&
      current.threadId === target.threadId
    );
  }

  toggle(target: VoiceSessionTarget): void {
    if (this.isActiveFor(target)) {
      this.stop();
    } else {
      void this.start(target);
    }
  }

  async start(target: VoiceSessionTarget): Promise<void> {
    this.stop();
    const session: ActiveSession = {
      target,
      id: this.nextSessionId++,
      microphone: null,
      peer: null,
      cancelSession: null,
      stopRemoteAudio: null,
      backendStarted: false,
      peerConnected: false,
      connectTimer: null,
      levelTimer: null,
      sampling: false,
    };
    this.session = session;
    this.setState({
      ...INITIAL_VOICE_MODE_STATE,
      phase: "connecting",
      target,
      muted: this.state.muted,
    });

    try {
      const microphone = await this.platform.getMicrophone();
      if (this.session !== session) {
        for (const track of microphone.getTracks()) track.stop();
        microphone.release?.();
        return;
      }
      session.microphone = microphone;
      // Timed from here so a first-run permission prompt doesn't count against it.
      session.connectTimer = setTimeout(
        () => this.fail(session, "Voice connection timed out."),
        VOICE_CONNECT_TIMEOUT_MS,
      );
      for (const track of microphone.getAudioTracks()) track.enabled = !this.state.muted;

      const peer = this.platform.createPeerConnection();
      session.peer = peer;
      peer.addEventListener(
        "track",
        (event: { readonly streams?: ReadonlyArray<VoiceMediaStream> }) => {
          const [remote] = event.streams ?? [];
          if (!remote || this.session !== session) return;
          session.stopRemoteAudio?.();
          session.stopRemoteAudio = this.platform.playRemoteAudio(remote);
        },
      );
      peer.addEventListener("connectionstatechange", () => {
        if (this.session !== session) return;
        if (peer.connectionState === "connected") {
          session.peerConnected = true;
          this.maybeActivate(session);
        } else if (peer.connectionState === "failed") {
          this.fail(session, "Voice connection was lost.");
        }
      });
      for (const track of microphone.getAudioTracks()) {
        peer.addTrack(track as never, microphone as never);
      }
      // Codex's realtime transport requires the ordered events channel in the offer.
      peer.createDataChannel("oai-events", { ordered: true });
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer as never);
      if (this.session !== session) return;
      if (!offer.sdp) throw new Error("Could not create a voice connection offer.");

      session.cancelSession = this.platform.openSession(
        { ...target, offerSdp: offer.sdp },
        {
          onEvent: (event) => this.handleEvent(session, event),
          onError: (message) => this.fail(session, message),
          onEnd: () => this.end(session, null),
        },
      );
    } catch (cause) {
      this.fail(session, describeError(cause));
    }
  }

  stop(): void {
    const session = this.session;
    if (!session) return;
    this.teardown(session);
    this.setState({ ...INITIAL_VOICE_MODE_STATE, muted: this.state.muted });
  }

  setMuted(muted: boolean): void {
    for (const track of this.session?.microphone?.getAudioTracks() ?? []) track.enabled = !muted;
    this.setState({ ...this.state, muted });
  }

  toggleMuted(): void {
    this.setMuted(!this.state.muted);
  }

  /** Clears a finished conversation's error or end notice. */
  dismiss(): void {
    if (this.state.phase !== "idle") return;
    this.setState({ ...this.state, error: null, endedReason: null });
  }

  private handleEvent(session: ActiveSession, event: ProviderVoiceSessionEvent): void {
    if (this.session !== session) return;
    switch (event.type) {
      case "answer":
        session.peer
          ?.setRemoteDescription({ type: "answer", sdp: event.sdp } as never)
          .catch((cause: unknown) => this.fail(session, describeError(cause)));
        return;
      case "started":
        session.backendStarted = true;
        this.maybeActivate(session);
        return;
      case "transcript.delta":
        this.setState({
          ...this.state,
          captions: appendVoiceCaption(this.state.captions, event.role, event.delta),
        });
        return;
      case "transcript.done":
        this.setState({
          ...this.state,
          captions: finishVoiceCaption(this.state.captions, event.role, event.text),
        });
        return;
      case "closed":
        this.end(session, event.reason ?? null);
        return;
    }
  }

  private maybeActivate(session: ActiveSession): void {
    if (!session.backendStarted || !session.peerConnected || this.state.phase === "active") return;
    if (session.connectTimer) clearTimeout(session.connectTimer);
    session.connectTimer = null;
    session.levelTimer = setInterval(() => this.sampleLevels(session), LEVEL_SAMPLE_INTERVAL_MS);
    this.setState({ ...this.state, phase: "active" });
  }

  private sampleLevels(session: ActiveSession): void {
    // Native getStats serializes the whole report, so never stack calls.
    if (this.levelListeners.size === 0 || !session.peer || session.sampling) return;
    session.sampling = true;
    session.peer
      .getStats()
      .finally(() => {
        session.sampling = false;
      })
      .then((report) => {
        if (this.session !== session) return;
        let microphone = 0;
        let speaker = 0;
        report.forEach((stat) => {
          const level = (stat as { readonly audioLevel?: unknown }).audioLevel;
          if (typeof level !== "number" || stat.kind !== "audio") return;
          if (stat.type === "media-source") microphone = Math.max(microphone, level);
          else if (stat.type === "inbound-rtp") speaker = Math.max(speaker, level);
        });
        const levels = { microphone: this.state.muted ? 0 : microphone, speaker };
        for (const listener of this.levelListeners) listener(levels);
      })
      .catch(() => undefined);
  }

  private end(session: ActiveSession, reason: string | null): void {
    if (this.session !== session) return;
    this.teardown(session);
    this.setState({
      ...INITIAL_VOICE_MODE_STATE,
      target: session.target,
      muted: this.state.muted,
      endedReason: reason ?? "ended",
    });
  }

  private fail(session: ActiveSession, message: string): void {
    if (this.session !== session) return;
    this.teardown(session);
    this.setState({
      ...INITIAL_VOICE_MODE_STATE,
      target: session.target,
      muted: this.state.muted,
      error: message,
    });
  }

  private teardown(session: ActiveSession): void {
    if (this.session === session) this.session = null;
    if (session.connectTimer) clearTimeout(session.connectTimer);
    if (session.levelTimer) clearInterval(session.levelTimer);
    session.cancelSession?.();
    session.stopRemoteAudio?.();
    session.peer?.close();
    for (const track of session.microphone?.getTracks() ?? []) track.stop();
    session.microphone?.release?.();
    for (const listener of this.levelListeners) listener({ microphone: 0, speaker: 0 });
  }

  private setState(next: VoiceModeState): void {
    this.state = next;
    // Read the latest state per listener: an earlier listener may have changed it.
    for (const listener of [...this.listeners]) listener(this.state);
  }
}
