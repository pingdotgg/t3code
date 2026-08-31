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
): TranscriptCommitResult {
  if (
    !current ||
    current.ownerKey !== captured.ownerKey ||
    current.text !== captured.text ||
    current.revision !== captured.revision
  ) {
    return { kind: "stale" };
  }

  const replacement = transcript.trim();
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
      left !== undefined &&
      /[A-Za-z0-9.!?,:;)\]}'"]/.test(left) &&
      (right === undefined || /\s/.test(right));
    const rightNeedsBoundary =
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
  private readonly dependencies: VoiceInputControllerDependencies;
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

  constructor(dependencies: VoiceInputControllerDependencies) {
    this.dependencies = dependencies;
  }

  get currentState(): VoiceInputState {
    return this.state;
  }

  async start(): Promise<void> {
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
      const transcriber = this.dependencies.getTranscriber();
      if (!transcriber) {
        this.setError("Voice transcription is not available.", null);
        return;
      }

      const permission = await this.dependencies.requestPermission();
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

      await this.dependencies.configureRecording();
      this.recordingConfigured = true;
      if (!this.isCurrent(operationToken)) return;
      await this.dependencies.recorder.prepareToRecordAsync();
      if (!this.isCurrent(operationToken)) return;
      this.recordingUri = this.dependencies.recorder.uri;
      this.rememberRecordingUri(this.recordingUri);

      const capturedDraft = this.dependencies.readDraft();
      if (!capturedDraft || capturedDraft.ownerKey !== initiatingDraft.ownerKey) {
        this.setError("This draft is no longer available.", "retry");
        return;
      }
      this.capturedDraft = capturedDraft;
      this.dependencies.recorder.record({ forDuration: VOICE_RECORDING_LIMIT_SECONDS });
      this.setState({ phase: "recording", error: null, errorAction: null });
    } catch {
      if (this.isCurrent(operationToken))
        this.setError("Could not start voice recording.", "retry");
    } finally {
      if (this.isCurrent(operationToken) && this.state.phase === "error") {
        await this.releaseResources();
      } else if (!this.isCurrent(operationToken) && !this.finishing) {
        await this.releaseResources();
      }
    }
  }

  stop(): Promise<void> {
    if (this.state.phase !== "recording") return Promise.resolve();
    return this.finishRecording(false, null);
  }

  cancel(): void {
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
    this.finishing = true;
    const operationToken = this.operationToken;
    this.setState({ phase: "transcribing", error: null, errorAction: null });

    try {
      if (!alreadyStopped) await this.dependencies.recorder.stop();
      await this.releaseAudioSession();
      this.recordingUri = completedUri ?? this.dependencies.recorder.uri ?? this.recordingUri;
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
    this.invalidateOperation();
    this.setState(
      error
        ? { phase: "error", error, errorAction: "retry" }
        : { phase: "idle", error: null, errorAction: null },
    );
    try {
      await this.dependencies.recorder.stop();
      this.rememberRecordingUri(this.dependencies.recorder.uri);
    } catch {
      this.rememberRecordingUri(this.dependencies.recorder.uri);
    } finally {
      await this.releaseResources();
    }
  }

  private async releaseResources(): Promise<void> {
    this.rememberRecordingUri(this.recordingUri);
    this.rememberRecordingUri(this.dependencies.recorder.uri);
    this.recordingUri = null;
    for (const uri of this.ownedRecordingUris) {
      try {
        this.dependencies.deleteRecording(uri);
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

  private rememberRecordingUri(uri: string | null): void {
    if (uri) this.ownedRecordingUris.add(uri);
  }

  private async releaseAudioSession(): Promise<void> {
    if (!this.recordingConfigured) return;
    try {
      await this.dependencies.releaseRecording();
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
    return operationToken === this.operationToken;
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
