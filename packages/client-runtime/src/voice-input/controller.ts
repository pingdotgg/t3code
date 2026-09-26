import { replaceTextRange } from "@t3tools/shared/composerTrigger";

import type { PreparedVoiceTranscription, VoiceTranscriber } from "./transcription.ts";

export const VOICE_RECORDING_LIMIT_SECONDS = 5 * 60;

export type VoiceInputPhase = "idle" | "preparing" | "recording" | "transcribing" | "error";

export type VoiceInputState = {
  readonly phase: VoiceInputPhase;
  readonly error: string | null;
  readonly errorAction: "retry" | "settings" | null;
};

export function voiceInputBlocksSubmission(state: VoiceInputState): boolean {
  return (
    state.phase === "preparing" || state.phase === "recording" || state.phase === "transcribing"
  );
}

export function voiceInputFreezesEditor(state: VoiceInputState): boolean {
  return voiceInputBlocksSubmission(state);
}

export type VoiceDraftSnapshot = {
  readonly ownerKey: string;
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
  readonly revision: number;
};

export type VoiceRecorderStatus = {
  readonly isFinished: boolean;
  readonly hasError: boolean;
  readonly error: string | null;
  readonly url: string | null;
};

export interface VoiceRecorder {
  readonly uri: string | null;
  prepareToRecordAsync(): Promise<void>;
  record(options: { readonly forDuration: number }): void;
  stop(): Promise<void>;
}

export type VoiceInputControllerDependencies = {
  readonly recorder: VoiceRecorder;
  readonly getTranscriber: () => VoiceTranscriber | null;
  readonly requestPermission: () => Promise<{
    readonly granted: boolean;
    readonly canAskAgain: boolean;
  }>;
  readonly configureRecording: () => Promise<void>;
  readonly releaseRecording: () => Promise<void>;
  readonly deleteRecording: (uri: string) => void;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
  readonly onStateChange: (state: VoiceInputState) => void;
};

export type VoiceTranscriptChange = {
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly insertion: string;
  readonly expectedText: string;
};

export type StreamingVoiceRecorder = {
  start(): void | Promise<void>;
  stop(): Promise<{ text: string; locale: string }>;
  dispose(): void;
};

export type StreamingVoiceInputDependencies = {
  readonly mode: "streaming";
  readonly createRecorder: (callbacks: {
    onTranscript: (text: string) => void;
    onError: (error: Error) => void;
  }) => StreamingVoiceRecorder;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
    change?: VoiceTranscriptChange,
  ) => boolean | void;
  readonly onStateChange: (state: VoiceInputState) => void;
  readonly onComplete?: (draft: VoiceDraftSnapshot) => void;
  readonly formatTranscript?: (text: string) => string;
  readonly now: () => number;
};

type TranscriptCommitResult =
  | {
      readonly kind: "commit";
      readonly text: string;
      readonly selection: { readonly start: number; readonly end: number };
    }
  | { readonly kind: "stale" }
  | { readonly kind: "empty" };

export function resolveTranscriptCommit(
  captured: VoiceDraftSnapshot,
  current: VoiceDraftSnapshot | null,
  transcript: string,
  locale: string,
  options?: { readonly preserveWhitespace?: boolean },
): TranscriptCommitResult {
  if (
    !current ||
    current.ownerKey !== captured.ownerKey ||
    current.text !== captured.text ||
    current.revision !== captured.revision
  ) {
    return { kind: "stale" };
  }

  const replacement = options?.preserveWhitespace ? transcript : transcript.trim();
  if (replacement.length === 0) {
    return { kind: "empty" };
  }

  const isEmptySelection = captured.selection.start === captured.selection.end;
  const normalizedLocale = locale.replaceAll("_", "-").toLowerCase();
  const usesEnglishSpacing = normalizedLocale === "en" || normalizedLocale.startsWith("en-");
  let insertion = replacement;
  if (isEmptySelection && usesEnglishSpacing) {
    const left = captured.text[captured.selection.start - 1];
    const right = captured.text[captured.selection.start];
    const leftNeedsBoundary =
      !/^[\s.,!?:;)}\]]/.test(replacement) &&
      left !== undefined &&
      /[A-Za-z0-9.!?,:;)\]}'"]/.test(left) &&
      (right === undefined || /\s/.test(right));
    const rightNeedsBoundary =
      !/\s$/.test(replacement) &&
      right !== undefined &&
      /[A-Za-z0-9([{'"]/.test(right) &&
      (left === undefined || /\s/.test(left));
    insertion = `${leftNeedsBoundary ? " " : ""}${replacement}${rightNeedsBoundary ? " " : ""}`;
  }

  const result = replaceTextRange(
    captured.text,
    captured.selection.start,
    captured.selection.end,
    insertion,
  );
  return {
    kind: "commit",
    text: result.text,
    selection: { start: result.cursor, end: result.cursor },
  };
}

let activeSession: symbol | null = null;
let activeTranscriptionOperation: Promise<unknown> | null = null;

function acquireSession(): symbol | null {
  if (activeSession) return null;
  const token = Symbol("voice-input-session");
  activeSession = token;
  return token;
}

function releaseSession(token: symbol | null): void {
  if (token && activeSession === token) activeSession = null;
}

async function runTranscriptionOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (activeTranscriptionOperation) {
    throw new Error("voice-operation-busy");
  }

  const promise = operation();
  activeTranscriptionOperation = promise;
  try {
    return await promise;
  } finally {
    if (activeTranscriptionOperation === promise) activeTranscriptionOperation = null;
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function preparationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === "voice-operation-busy") {
    return "Voice transcription is still finishing. Try again shortly.";
  }
  if (errorCode(error) === "unsupported-locale") {
    return "Voice transcription is not available for this language.";
  }
  return "Could not prepare voice transcription.";
}

function transcriptionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === "voice-operation-busy") {
    return "Voice transcription is still finishing. Try again shortly.";
  }
  return "Could not transcribe this recording.";
}

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export class VoiceInputController {
  private readonly dependencies: VoiceInputControllerDependencies | StreamingVoiceInputDependencies;
  private state: VoiceInputState = IDLE_STATE;
  private operationToken = 0;
  private sessionToken: symbol | null = null;
  private transcription: PreparedVoiceTranscription | null = null;
  private transcriptionAbortController: AbortController | null = null;
  private capturedDraft: VoiceDraftSnapshot | null = null;
  private recordingUri: string | null = null;
  private readonly ownedRecordingUris = new Set<string>();
  private recordingConfigured = false;
  private finishing = false;

  constructor(dependencies: VoiceInputControllerDependencies | StreamingVoiceInputDependencies) {
    this.dependencies = dependencies;
  }

  private streamingRecorder: StreamingVoiceRecorder | null = null;
  private segmentDraft: VoiceDraftSnapshot | null = null;
  private lastApplied: VoiceDraftSnapshot | null = null;
  private transcript = "";
  private segmentOffset = 0;
  private segmentEnd = 0;
  private startedAt = 0;
  private elapsedSeconds = 0;
  private disposed = false;

  private get streaming(): StreamingVoiceInputDependencies | null {
    return "mode" in this.dependencies ? this.dependencies : null;
  }

  private get recorded(): VoiceInputControllerDependencies {
    if ("mode" in this.dependencies) throw new Error("Recording-file adapter is unavailable.");
    return this.dependencies;
  }

  get busy(): boolean {
    return voiceInputBlocksSubmission(this.state);
  }

  getElapsedSeconds(): number {
    return this.state.phase === "recording" ? this.computeElapsed() : this.elapsedSeconds;
  }

  dismissError(): void {
    if (this.state.phase === "error") this.setState(IDLE_STATE);
  }

  tick(): void {
    if (this.disposed || !this.streaming || this.state.phase !== "recording") return;
    this.elapsedSeconds = this.computeElapsed();
    if (this.elapsedSeconds >= VOICE_RECORDING_LIMIT_SECONDS) void this.stop();
  }

  get currentState(): VoiceInputState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    if (this.state.phase !== "idle" && this.state.phase !== "error") return;
    const initiatingDraft = this.dependencies.readDraft();
    if (!initiatingDraft) {
      this.setError("This draft is no longer available.", "retry");
      return;
    }
    const sessionToken = acquireSession();
    if (!sessionToken) {
      this.setError("Another voice recording is already active.", "retry");
      return;
    }

    this.sessionToken = sessionToken;
    const operationToken = ++this.operationToken;
    const abortController = new AbortController();
    this.transcriptionAbortController = abortController;
    this.setState({ phase: "preparing", error: null, errorAction: null });

    try {
      if (this.streaming) {
        await this.startStreaming(operationToken, initiatingDraft);
        return;
      }
      const transcriber = this.recorded.getTranscriber();
      if (!transcriber) {
        this.setError("Voice transcription is not available.", null);
        return;
      }

      const permission = await this.recorded.requestPermission();
      if (!this.isCurrent(operationToken)) return;
      if (!permission.granted) {
        this.setError(
          "Microphone access is required for voice input.",
          permission.canAskAgain ? "retry" : "settings",
        );
        return;
      }

      try {
        this.transcription = await runTranscriptionOperation(() =>
          transcriber.prepare({ signal: abortController.signal }),
        );
      } catch (error) {
        if (this.isCurrent(operationToken)) this.setError(preparationErrorMessage(error), "retry");
        return;
      }
      if (!this.isCurrent(operationToken)) return;

      await this.recorded.configureRecording();
      this.recordingConfigured = true;
      if (!this.isCurrent(operationToken)) return;
      await this.recorded.recorder.prepareToRecordAsync();
      if (!this.isCurrent(operationToken)) return;
      this.recordingUri = this.recorded.recorder.uri;
      this.rememberRecordingUri(this.recordingUri);

      const capturedDraft = this.dependencies.readDraft();
      if (!capturedDraft || capturedDraft.ownerKey !== initiatingDraft.ownerKey) {
        this.setError("This draft is no longer available.", "retry");
        return;
      }
      this.capturedDraft = capturedDraft;
      this.recorded.recorder.record({ forDuration: VOICE_RECORDING_LIMIT_SECONDS });
      this.setState({ phase: "recording", error: null, errorAction: null });
    } catch (error) {
      if (this.isCurrent(operationToken)) {
        const denied =
          error instanceof Error &&
          (error.name === "NotAllowedError" || error.name === "SecurityError");
        this.setError(
          this.streaming
            ? denied
              ? "Microphone access was denied."
              : error instanceof Error
                ? error.message
                : "Could not start voice recording."
            : "Could not start voice recording.",
          "retry",
        );
      }
    } finally {
      if (this.isCurrent(operationToken) && this.state.phase === "error") {
        await this.releaseResources();
      } else if (!this.streaming && !this.isCurrent(operationToken) && !this.finishing) {
        await this.releaseResources();
      }
    }
  }

  stop(): Promise<void> {
    if (this.state.phase !== "recording") return Promise.resolve();
    return this.finishRecording(false, null);
  }

  cancel(): void {
    if (this.streaming) {
      this.invalidateOperation();
      this.finishing = false;
      this.releaseStreaming();
      this.setState(IDLE_STATE);
      return;
    }
    switch (this.state.phase) {
      case "idle":
        return;
      case "error":
        this.setState(IDLE_STATE);
        return;
      case "preparing":
        this.invalidateOperation();
        this.setState(IDLE_STATE);
        return;
      case "recording":
        this.discardRecording(null);
        return;
      case "transcribing":
        this.invalidateOperation();
        this.setState(IDLE_STATE);
        return;
    }
  }

  interruptRecording(
    message = "Voice recording was interrupted.",
    completedUri: string | null = null,
  ): Promise<void> | void {
    if (this.state.phase !== "recording") return;
    this.rememberRecordingUri(completedUri);
    this.recordingUri = completedUri ?? this.recordingUri;
    return this.discardRecording(message);
  }

  appMovedToBackground(): Promise<void> | void {
    if (this.state.phase === "preparing") {
      this.invalidateOperation();
      if (this.streaming) this.releaseStreaming();
      this.setError("Voice input stopped when the app moved to the background.", "retry");
      return;
    }
    return this.interruptRecording();
  }

  handleRecorderStatus(status: VoiceRecorderStatus): Promise<void> | void {
    if (this.state.phase !== "recording") return;
    if (status.hasError) {
      return this.interruptRecording(
        status.error ?? "Voice recording was interrupted.",
        status.url,
      );
    }
    if (status.isFinished) {
      if (!status.url) {
        return this.interruptRecording();
      }
      return this.finishRecording(true, status.url);
    }
  }

  ownerChanged(): void {
    if (this.state.phase === "idle") return;
    this.cancel();
  }

  dispose(): void {
    if (this.streaming) {
      this.disposed = true;
      this.invalidateOperation();
      this.finishing = false;
      this.releaseStreaming();
      return;
    }
    if (this.state.phase === "recording") {
      this.discardRecording(null);
      return;
    }
    if (this.state.phase === "preparing" || this.state.phase === "transcribing") {
      this.invalidateOperation();
      this.setState(IDLE_STATE);
    }
  }

  private async finishRecording(
    alreadyStopped: boolean,
    completedUri: string | null,
  ): Promise<void> {
    if (this.finishing || this.state.phase !== "recording") return;
    if (this.streaming) return this.finishStreaming();
    this.finishing = true;
    const operationToken = this.operationToken;
    this.setState({ phase: "transcribing", error: null, errorAction: null });

    try {
      if (!alreadyStopped) await this.recorded.recorder.stop();
      await this.releaseAudioSession();
      this.recordingUri = completedUri ?? this.recorded.recorder.uri ?? this.recordingUri;
      this.rememberRecordingUri(this.recordingUri);
      if (!this.isCurrent(operationToken)) return;
      if (
        !this.recordingUri ||
        !this.transcription ||
        !this.transcriptionAbortController ||
        !this.capturedDraft
      ) {
        this.setError("Could not finish voice recording.", "retry");
        return;
      }

      const recordingUri = this.recordingUri;
      const transcription = this.transcription;
      const signal = this.transcriptionAbortController.signal;
      const capturedDraft = this.capturedDraft;
      let transcript: string;
      try {
        transcript = await runTranscriptionOperation(() =>
          transcription.transcribe(recordingUri, { signal }),
        );
      } catch (error) {
        if (this.isCurrent(operationToken)) {
          this.setError(transcriptionErrorMessage(error), "retry");
        }
        return;
      }
      if (!this.isCurrent(operationToken)) return;

      const result = resolveTranscriptCommit(
        capturedDraft,
        this.dependencies.readDraft(),
        transcript,
        transcription.locale,
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

      this.dependencies.commitDraft(result.text, result.selection);
      this.setState(IDLE_STATE);
    } catch {
      if (this.isCurrent(operationToken)) {
        this.setError("Could not finish voice recording.", "retry");
      }
    } finally {
      this.finishing = false;
      await this.releaseResources();
    }
  }

  private async discardRecording(error: string | null): Promise<void> {
    if (this.streaming) {
      this.cancel();
      if (error) this.setError(error, "retry");
      return;
    }
    this.invalidateOperation();
    this.setState(
      error
        ? { phase: "error", error, errorAction: "retry" }
        : { phase: "idle", error: null, errorAction: null },
    );
    try {
      await this.recorded.recorder.stop();
      this.rememberRecordingUri(this.recorded.recorder.uri);
    } catch {
      this.rememberRecordingUri(this.recorded.recorder.uri);
    } finally {
      await this.releaseResources();
    }
  }

  private async releaseResources(): Promise<void> {
    if (this.streaming) {
      this.releaseStreaming();
      return;
    }
    this.rememberRecordingUri(this.recordingUri);
    this.rememberRecordingUri(this.recorded.recorder.uri);
    this.recordingUri = null;
    for (const uri of this.ownedRecordingUris) {
      try {
        this.recorded.deleteRecording(uri);
      } catch {
        // The cache may already have removed a failed or interrupted recording.
      }
    }
    this.ownedRecordingUris.clear();
    await this.releaseAudioSession();
    releaseSession(this.sessionToken);
    this.sessionToken = null;
    this.capturedDraft = null;
    this.transcription = null;
    this.transcriptionAbortController = null;
  }

  private async startStreaming(token: number, draft: VoiceDraftSnapshot): Promise<void> {
    const dependencies = this.streaming;
    if (!dependencies) return;
    this.capturedDraft = draft;
    this.segmentDraft = draft;
    this.lastApplied = draft;
    this.transcript = "";
    this.segmentOffset = 0;
    this.segmentEnd = draft.selection.end;
    this.elapsedSeconds = 0;
    const recorder = dependencies.createRecorder({
      onTranscript: (text) => {
        if (this.isCurrent(token) && this.busy) this.applyTranscript(text);
      },
      onError: (error) => {
        if (!this.isCurrent(token) || this.state.phase !== "recording") return;
        this.invalidateOperation();
        this.releaseStreaming();
        this.setError(error.message, "retry");
      },
    });
    this.streamingRecorder = recorder;
    await recorder.start();
    if (!this.isCurrent(token)) return;
    if (this.dependencies.readDraft()?.ownerKey !== draft.ownerKey) {
      this.setError("This draft is no longer available.", "retry");
      return;
    }
    this.startedAt = dependencies.now();
    this.setState({ phase: "recording", error: null, errorAction: null });
  }

  private async finishStreaming(): Promise<void> {
    const recorder = this.streamingRecorder;
    if (!recorder) return;
    this.finishing = true;
    const token = this.operationToken;
    this.elapsedSeconds = this.computeElapsed();
    this.setState({ phase: "transcribing", error: null, errorAction: null });
    try {
      const result = await recorder.stop();
      if (!this.isCurrent(token)) return;
      if (!result.text.trim()) {
        this.setError("No speech was detected.", "retry");
        return;
      }
      const hasFinalWords = result.text !== this.transcript;
      if (!this.applyTranscript(result.text, result.locale)) {
        this.setError(
          "The draft changed while voice input was running. The transcript was not added.",
          "retry",
        );
        return;
      }
      const completed = hasFinalWords ? this.lastApplied : this.dependencies.readDraft();
      this.releaseStreaming();
      this.setState(IDLE_STATE);
      if (completed?.text.trim()) this.streaming?.onComplete?.(completed);
    } catch (error) {
      if (this.isCurrent(token))
        this.setError(
          error instanceof Error ? error.message : "Could not finish voice recording.",
          "retry",
        );
    } finally {
      if (this.isCurrent(token)) {
        this.finishing = false;
        this.releaseStreaming();
      }
    }
  }

  private computeElapsed(): number {
    return Math.min(
      VOICE_RECORDING_LIMIT_SECONDS,
      Math.max(0, Math.floor(((this.streaming?.now() ?? this.startedAt) - this.startedAt) / 1000)),
    );
  }

  private releaseStreaming(): void {
    try {
      this.streamingRecorder?.dispose();
    } catch {
      // A transport failure must not retain ownership of the microphone session.
    }
    this.streamingRecorder = null;
    releaseSession(this.sessionToken);
    this.sessionToken = null;
    this.capturedDraft = null;
    this.elapsedSeconds = 0;
    this.transcriptionAbortController = null;
  }

  /** Update only our current insertion; moving or editing starts a new one. */
  private applyTranscript(text: string, locale = "en"): boolean {
    const current = this.dependencies.readDraft();
    if (!current || current.ownerKey !== this.capturedDraft?.ownerKey) return false;
    if (text === this.transcript) return true;
    // Realtime input chunks are cumulative. Never replay old speech after edits.
    if (!text.startsWith(this.transcript)) return false;
    const previous = this.lastApplied;
    const moved =
      !previous ||
      current.text !== previous.text ||
      current.selection.start !== previous.selection.start ||
      current.selection.end !== previous.selection.end;
    if (moved) {
      this.segmentDraft = current;
      this.segmentOffset = this.transcript.length;
      this.segmentEnd = current.selection.end;
    }
    const base = this.segmentDraft;
    if (!base) return false;
    const formatted = (this.streaming?.formatTranscript ?? ((value: string) => value))(
      text.slice(this.segmentOffset).trim(),
    );
    const result = resolveTranscriptCommit(base, base, formatted, locale, {
      preserveWhitespace: true,
    });
    if (result.kind === "stale") return false;
    if (result.kind === "empty" && current.text === base.text) {
      this.transcript = text;
      this.lastApplied = current;
      return true;
    }
    const end = this.segmentEnd;
    const insertion =
      result.kind === "empty"
        ? base.text.slice(base.selection.start, base.selection.end)
        : result.text.slice(base.selection.start, result.selection.start);
    const applied = this.streaming?.commitDraft(
      result.kind === "empty" ? base.text : result.text,
      result.kind === "empty" ? base.selection : result.selection,
      {
        rangeStart: base.selection.start,
        rangeEnd: end,
        insertion,
        expectedText: current.text.slice(base.selection.start, end),
      },
    );
    if (applied === false) return false;
    this.transcript = text;
    this.segmentEnd = base.selection.start + insertion.length;
    this.lastApplied =
      result.kind === "empty"
        ? {
            ...current,
            text: base.text,
            selection: { start: this.segmentEnd, end: this.segmentEnd },
          }
        : { ...current, text: result.text, selection: result.selection };
    return true;
  }

  private rememberRecordingUri(uri: string | null): void {
    if (uri) this.ownedRecordingUris.add(uri);
  }

  private async releaseAudioSession(): Promise<void> {
    if (!this.recordingConfigured) return;
    try {
      await this.recorded.releaseRecording();
      this.recordingConfigured = false;
    } catch {
      // Final cleanup retries if the prompt release before transcription fails.
    }
  }

  private invalidateOperation(): void {
    this.operationToken += 1;
    this.transcriptionAbortController?.abort();
  }

  private isCurrent(operationToken: number): boolean {
    return !this.disposed && operationToken === this.operationToken;
  }

  private setError(error: string, errorAction: VoiceInputState["errorAction"]): void {
    this.setState({ phase: "error", error, errorAction });
  }

  private setState(state: VoiceInputState): void {
    this.state = state;
    this.dependencies.onStateChange(state);
  }
}

export function resetVoiceInputGlobalsForTests(): void {
  activeSession = null;
  activeTranscriptionOperation = null;
}
