import {
  VOICE_RECORDING_LIMIT_SECONDS,
  resolveTranscriptCommit,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { ProviderDriverKind } from "@t3tools/contracts";

/**
 * Framework-free voice dictation session for the web composer.
 *
 * Mirrors the mobile `VoiceInputController` flow (prepare -> record ->
 * transcribe -> guarded commit) but binds to browser primitives
 * (`MediaRecorder`, server transcription) instead of expo-av. The pure
 * commit guard (`resolveTranscriptCommit`) and phase model are reused from
 * `@t3tools/client-runtime/voice-input` so owner/revision/selection
 * semantics stay identical across clients: a late transcript can never
 * overwrite a draft the user kept editing.
 */

export type ComposerVoiceDraft = {
  readonly ownerKey: string;
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
};

export type ComposerVoiceCommit = {
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly insertion: string;
  readonly expectedText: string;
};

export type ComposerVoiceRecorder = {
  readonly mimeType: string;
  start(): void;
  stop(): Promise<Blob>;
  dispose(): void;
};

export type ComposerVoiceTranscriber = (
  audio: Blob,
  options: { readonly signal: AbortSignal },
) => Promise<{ readonly text: string; readonly locale: string }>;

export type ComposerVoiceSessionDependencies = {
  readonly readDraft: () => ComposerVoiceDraft | null;
  readonly commitDraft: (commit: ComposerVoiceCommit) => boolean;
  readonly transcribe: ComposerVoiceTranscriber;
  readonly requestMicrophone: () => Promise<MediaStream>;
  readonly createRecorder: (
    stream: MediaStream,
    callbacks: { readonly onError: (error: Error) => void },
  ) => ComposerVoiceRecorder;
  readonly onStateChange: (state: VoiceInputState) => void;
  readonly now?: () => number;
};

export const IDLE_COMPOSER_VOICE_STATE: VoiceInputState = {
  phase: "idle",
  error: null,
  errorAction: null,
};

export const VOICE_BUSY_SEND_DISABLED_REASON = "Finish voice input before sending";

export const VOICE_NON_CODEX_DISABLED_REASON = "Voice for this provider is coming soon";

export const VOICE_CODEX_LOGIN_DISABLED_REASON = "Sign in with `codex login`";

export const VOICE_COMPOSER_BUSY_DISABLED_REASON =
  "Voice input is unavailable while the composer is busy";

export function resolveVoiceSendDisabledReason(input: {
  readonly external: string | null;
  readonly voiceBusy: boolean;
  readonly fallback: string | null;
}) {
  return (
    input.external ?? (input.voiceBusy ? VOICE_BUSY_SEND_DISABLED_REASON : null) ?? input.fallback
  );
}

export function resolveVoiceMicAvailability(input: {
  readonly driverKind: ProviderDriverKind;
  readonly codexVoiceAvailable: boolean;
  readonly composerDisabled: boolean;
}) {
  if (input.driverKind !== "codex") {
    return { available: false, reason: VOICE_NON_CODEX_DISABLED_REASON } as const;
  }
  if (!input.codexVoiceAvailable) {
    return { available: false, reason: VOICE_CODEX_LOGIN_DISABLED_REASON } as const;
  }
  if (input.composerDisabled) {
    return { available: false, reason: VOICE_COMPOSER_BUSY_DISABLED_REASON } as const;
  }
  return { available: true } as const;
}

export function formatVoiceElapsed(totalSeconds: number) {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(clamped / 60)}:${String(clamped % 60).padStart(2, "0")}`;
}

const PREFERRED_VOICE_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

export function pickSupportedVoiceMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }
  return PREFERRED_VOICE_MIME_TYPES.find((mime) => MediaRecorder.isTypeSupported(mime));
}

export function requestComposerMicrophone(): Promise<MediaStream> {
  const mediaDevices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!mediaDevices?.getUserMedia) {
    return Promise.reject(new Error("Voice input is not supported in this browser."));
  }
  return mediaDevices.getUserMedia({ audio: true });
}

export function createMediaRecorderVoiceRecorder(
  stream: MediaStream,
  callbacks?: { readonly onError?: (error: Error) => void },
): ComposerVoiceRecorder {
  const mimeType = pickSupportedVoiceMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  let pendingStop: {
    resolve: (blob: Blob) => void;
    reject: (error: unknown) => void;
  } | null = null;

  const takeAudio = () => new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
  const handleDataAvailable = (event: BlobEvent) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const handleStop = () => {
    const pending = pendingStop;
    pendingStop = null;
    pending?.resolve(takeAudio());
  };
  const handleError = () => {
    const failure = new Error("Microphone recording failed.");
    const pending = pendingStop;
    pendingStop = null;
    if (pending) {
      pending.reject(failure);
      return;
    }
    // No stop() is awaiting (normal recording): the session would otherwise
    // stay in `recording` forever, blocking send and risking a partial
    // submit on a later stop.
    callbacks?.onError?.(failure);
  };
  recorder.addEventListener("dataavailable", handleDataAvailable);
  recorder.addEventListener("stop", handleStop);
  recorder.addEventListener("error", handleError);

  return {
    get mimeType() {
      return recorder.mimeType || "audio/webm";
    },
    start() {
      recorder.start();
    },
    stop() {
      if (recorder.state === "inactive") return Promise.resolve(takeAudio());
      return new Promise<Blob>((resolve, reject) => {
        pendingStop = { resolve, reject };
        recorder.stop();
      });
    },
    dispose() {
      recorder.removeEventListener("dataavailable", handleDataAvailable);
      recorder.removeEventListener("stop", handleStop);
      recorder.removeEventListener("error", handleError);
      // Settle any awaiting stop() so a cancel/dispose during the
      // recording->transcribing handoff can't leave finishRecording()
      // pending forever with `finishing` stuck true.
      const pending = pendingStop;
      pendingStop = null;
      pending?.reject(new Error("Voice recording was cancelled."));
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // The recorder already errored or stopped racing us; tracks below
          // are still released by the session.
        }
      }
    },
  };
}

function isPermissionDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "NotAllowedError" || error.name === "SecurityError")
  );
}

function transcriptionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "Could not transcribe this recording.";
}

export class ComposerVoiceSession {
  private readonly dependencies: ComposerVoiceSessionDependencies;
  private state: VoiceInputState = IDLE_COMPOSER_VOICE_STATE;
  private generation = 0;
  private revision = 0;
  private lastSeen: { ownerKey: string; text: string } | null = null;
  private capturedDraft: VoiceDraftSnapshot | null = null;
  private stream: MediaStream | null = null;
  private recorder: ComposerVoiceRecorder | null = null;
  private aborter: AbortController | null = null;
  private startedAt = 0;
  private elapsedSeconds = 0;
  private finishing = false;
  private disposed = false;

  constructor(dependencies: ComposerVoiceSessionDependencies) {
    this.dependencies = dependencies;
  }

  get currentState(): VoiceInputState {
    return this.state;
  }

  get busy(): boolean {
    return voiceInputBlocksSubmission(this.state);
  }

  getElapsedSeconds(): number {
    if (this.state.phase === "recording") return this.computeElapsed();
    return this.elapsedSeconds;
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    if (this.state.phase !== "idle" && this.state.phase !== "error") return;
    const generation = ++this.generation;
    const draft = this.readRevisionedDraft();
    if (!draft) {
      this.setError("This draft is no longer available.", "retry");
      return;
    }
    this.capturedDraft = draft;
    this.elapsedSeconds = 0;
    this.setState({ phase: "preparing", error: null, errorAction: null });
    try {
      const stream = await this.dependencies.requestMicrophone();
      if (!this.isCurrent(generation)) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      const recorder = this.dependencies.createRecorder(stream, {
        onError: (recorderError) => {
          if (!this.isCurrent(generation)) return;
          if (this.state.phase !== "recording") return;
          this.cleanupCapture();
          this.capturedDraft = null;
          this.setError(transcriptionErrorMessage(recorderError), "retry");
        },
      });
      this.recorder = recorder;
      recorder.start();
      this.startedAt = this.now();
      this.setState({ phase: "recording", error: null, errorAction: null });
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.cleanupCapture();
      this.capturedDraft = null;
      this.setError(
        isPermissionDenied(error)
          ? "Microphone access was denied."
          : "Could not access the microphone.",
        "retry",
      );
    }
  }

  stop(): Promise<void> {
    if (this.state.phase !== "recording" || this.finishing) return Promise.resolve();
    return this.finishRecording();
  }

  cancel(): void {
    switch (this.state.phase) {
      case "idle":
        return;
      case "error":
        this.setState(IDLE_COMPOSER_VOICE_STATE);
        return;
      case "preparing":
      case "recording":
      case "transcribing":
        this.generation += 1;
        // Release the stop gate: cleanup settles any awaiting recorder.stop()
        // (dispose rejects pendingStop), and the stale finishRecording() below
        // must not clobber a fresh session's flag (see finally guard).
        this.finishing = false;
        this.cleanupCapture();
        this.capturedDraft = null;
        this.elapsedSeconds = 0;
        this.setState(IDLE_COMPOSER_VOICE_STATE);
        return;
    }
  }

  dismissError(): void {
    if (this.state.phase === "error") this.setState(IDLE_COMPOSER_VOICE_STATE);
  }

  /** Called on a cheap interval by the owner while recording; auto-stops at the cap. */
  tick(): void {
    if (this.disposed || this.state.phase !== "recording") return;
    this.elapsedSeconds = this.computeElapsed();
    if (this.elapsedSeconds >= VOICE_RECORDING_LIMIT_SECONDS) void this.finishRecording();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.finishing = false;
    this.cleanupCapture();
    this.capturedDraft = null;
  }

  private async finishRecording(): Promise<void> {
    if (this.finishing || this.state.phase !== "recording") return;
    this.finishing = true;
    const generation = this.generation;
    const captured = this.capturedDraft;
    const recorder = this.recorder;
    this.elapsedSeconds = this.computeElapsed();
    this.setState({ phase: "transcribing", error: null, errorAction: null });
    try {
      if (!recorder || !captured) {
        if (this.isCurrent(generation)) this.setError("Could not finish voice recording.", "retry");
        return;
      }
      let audio: Blob;
      try {
        audio = await recorder.stop();
      } catch (error) {
        // Release the microphone before reporting: a retry overwrites
        // this.stream, which would orphan the live tracks.
        this.cleanupCapture();
        if (this.isCurrent(generation)) this.setError(transcriptionErrorMessage(error), "retry");
        return;
      }
      this.cleanupCapture();
      if (!this.isCurrent(generation)) return;
      if (audio.size === 0) {
        this.setError("No speech was detected.", "retry");
        return;
      }
      const aborter = new AbortController();
      this.aborter = aborter;
      let transcript: string;
      let locale: string;
      try {
        ({ text: transcript, locale } = await this.dependencies.transcribe(audio, {
          signal: aborter.signal,
        }));
      } catch (error) {
        if (this.isCurrent(generation)) this.setError(transcriptionErrorMessage(error), "retry");
        return;
      } finally {
        if (this.aborter === aborter) this.aborter = null;
      }
      if (!this.isCurrent(generation)) return;
      const result = resolveTranscriptCommit(
        captured,
        this.readRevisionedDraft(),
        transcript,
        locale,
      );
      if (result.kind === "stale") {
        this.setError(
          "The draft changed while voice input was running. The transcript was not added.",
          "retry",
        );
        return;
      }
      if (result.kind === "empty") {
        this.setError("No speech was detected.", "retry");
        return;
      }
      const applied = this.dependencies.commitDraft({
        rangeStart: captured.selection.start,
        rangeEnd: captured.selection.end,
        insertion: result.text.slice(captured.selection.start, result.selection.start),
        expectedText: captured.text.slice(captured.selection.start, captured.selection.end),
      });
      if (!this.isCurrent(generation)) return;
      if (!applied) {
        this.setError(
          "The draft changed while voice input was running. The transcript was not added.",
          "retry",
        );
        return;
      }
      this.elapsedSeconds = 0;
      this.setState(IDLE_COMPOSER_VOICE_STATE);
    } finally {
      // A cancel/dispose bumps generation and already cleared the gate; only
      // clear here when still current so a stale finish can't unblock (or
      // re-block) a fresh session's stop().
      if (this.generation === generation) this.finishing = false;
    }
  }

  private readRevisionedDraft(): VoiceDraftSnapshot | null {
    const raw = this.dependencies.readDraft();
    if (!raw) return null;
    const last = this.lastSeen;
    if (!last || last.ownerKey !== raw.ownerKey || last.text !== raw.text) {
      this.revision += 1;
      this.lastSeen = { ownerKey: raw.ownerKey, text: raw.text };
    }
    const start = Math.max(0, Math.min(raw.text.length, raw.selectionStart));
    const end = Math.max(start, Math.min(raw.text.length, raw.selectionEnd));
    return {
      ownerKey: raw.ownerKey,
      text: raw.text,
      selection: { start, end },
      revision: this.revision,
    };
  }

  private computeElapsed(): number {
    return Math.min(
      VOICE_RECORDING_LIMIT_SECONDS,
      Math.max(0, Math.floor((this.now() - this.startedAt) / 1000)),
    );
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  private cleanupCapture(): void {
    this.aborter?.abort();
    this.aborter = null;
    try {
      this.recorder?.dispose();
    } catch {
      // Best effort: releasing tracks below matters more than recorder errors.
    }
    this.recorder = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // A track that refuses to stop must not break session teardown.
        }
      }
      this.stream = null;
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private setError(error: string, errorAction: VoiceInputState["errorAction"]): void {
    this.setState({ phase: "error", error, errorAction });
  }

  private setState(state: VoiceInputState): void {
    this.state = state;
    this.dependencies.onStateChange(state);
  }
}
