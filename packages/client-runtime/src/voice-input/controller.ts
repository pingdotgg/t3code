import * as Schema from "effect/Schema";
import { replaceTextRange } from "@t3tools/shared/composerTrigger";

import {
  VoiceTranscriptionError,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
} from "./transcription.ts";

const isVoiceTranscriptionError = Schema.is(VoiceTranscriptionError);

export const VOICE_RECORDING_LIMIT_SECONDS = 5 * 60;

/** The recording is kept, so retrying transcribes it again without recording. */
export const RETAINED_RECORDING_ERROR =
  "Could not transcribe this recording. It was kept for a retry.";

export const MICROPHONE_PERMISSION_ERROR =
  "Microphone access is required for voice input. Allow access in your browser or system settings and try again.";

function isMicrophonePermissionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "NotAllowedError"
  );
}

export type VoiceInputPhase =
  | "idle"
  | "preparing"
  | "recording"
  | "transcribing"
  | "post-processing"
  | "error";

export type VoiceInputState = {
  readonly phase: VoiceInputPhase;
  readonly error: string | null;
  readonly errorAction: "retry" | "settings" | null;
};

export function voiceInputBlocksSubmission(state: VoiceInputState): boolean {
  return (
    state.phase === "preparing" ||
    state.phase === "recording" ||
    state.phase === "transcribing" ||
    state.phase === "post-processing"
  );
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
  prepareToRecordAsync(signal?: AbortSignal): Promise<void>;
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
  /** Keep a recording whose transcription failed so the next start retries it without recording again. */
  readonly retryFailedRecording?: boolean;
  /**
   * Optional cleanup of the transcript before insertion. Returning null skips it for this
   * recording; a failure falls back to the raw transcript.
   */
  readonly postProcess?:
    | ((
        transcript: string,
        options: { readonly signal: AbortSignal; readonly draft: VoiceDraftSnapshot },
      ) => Promise<string> | null)
    | undefined;
  readonly onPostProcessingError?: (error: unknown) => void;
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

const WORD_SPACELESS_LANGUAGES = new Set(["ja", "zh", "yue", "th", "lo", "km", "my"]);

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
  const language = locale.split(/[-_]/)[0]!.toLowerCase();
  let insertion = replacement;
  if (isEmptySelection && !WORD_SPACELESS_LANGUAGES.has(language)) {
    const auto = language === "auto";
    const caret = captured.selection.start;
    const left = captured.text.slice(Math.max(0, caret - 2), caret);
    const right = captured.text.slice(caret, caret + 2);
    const leftEdge = auto ? /[A-Za-z0-9.!?,:;)\]}'"]$/ : /(?:\p{L}|\p{M}|\p{N}|[.!?,:;)\]}'"])$/u;
    const rightEdge = auto ? /^[A-Za-z0-9([{'"]/ : /^[\p{L}\p{M}\p{N}([{'"]/u;
    const leftNeedsBoundary =
      (!auto || /^[\p{Script=Latin}\p{N}]/u.test(replacement)) &&
      leftEdge.test(left) &&
      (!right || /^\s/.test(right));
    const rightNeedsBoundary =
      (!auto || /(?:\p{Script=Latin}|\p{N})$/u.test(replacement)) &&
      rightEdge.test(right) &&
      (!left || /\s$/.test(left));
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

type VoiceInputSession = {
  abandoned: boolean;
  readonly released: Promise<void>;
  readonly release: () => void;
};

let activeSession: VoiceInputSession | null = null;
let activeTranscriptionOperation: Promise<unknown> | null = null;

function acquireSession(): VoiceInputSession | null {
  if (activeSession) return null;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const token = { abandoned: false, released, release };
  activeSession = token;
  return token;
}

function releaseSession(token: VoiceInputSession | null): void {
  if (token && activeSession === token) {
    activeSession = null;
    token.release();
  }
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
  return isVoiceTranscriptionError(error) && error.message.trim()
    ? error.message
    : "Could not prepare voice transcription.";
}

function transcriptionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === "voice-operation-busy") {
    return "Voice transcription is still finishing. Try again shortly.";
  }
  return isVoiceTranscriptionError(error) ? error.message : "Could not transcribe this recording.";
}

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export class VoiceInputController {
  private readonly dependencies: VoiceInputControllerDependencies;
  private state: VoiceInputState = IDLE_STATE;
  private operationToken = 0;
  private sessionToken: VoiceInputSession | null = null;
  private transcription: PreparedVoiceTranscription | null = null;
  private liveTranscription: Promise<{ text: string | null } | { error: unknown }> | null = null;
  private transcriptionAbortController: AbortController | null = null;
  private postProcessingAbortController: AbortController | null = null;
  private skipPostProcessingRequested = false;
  private capturedDraft: VoiceDraftSnapshot | null = null;
  private recordingUri: string | null = null;
  private readonly ownedRecordingUris = new Set<string>();
  private recordingConfigured = false;
  private finishing = false;
  private retryRecording: {
    uri: string;
    ownerKey: string;
    transcription: PreparedVoiceTranscription;
  } | null = null;

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
    let sessionToken: VoiceInputSession | null = null;
    const operationToken = ++this.operationToken;
    this.setState({ phase: "preparing", error: null, errorAction: null });

    try {
      for (
        let previousSession = activeSession;
        previousSession?.abandoned;
        previousSession = activeSession
      ) {
        await previousSession.released;
        if (!this.isCurrent(operationToken)) return;
      }
      sessionToken = acquireSession();
      if (!sessionToken) {
        this.setError("Another voice recording is already active.", "retry");
        return;
      }
      this.sessionToken = sessionToken;
      const abortController = new AbortController();
      this.transcriptionAbortController = abortController;

      if (this.retryRecording && this.retryRecording.ownerKey !== initiatingDraft.ownerKey) {
        this.retryRecording = null;
        this.deleteOwnedRecordings();
      }
      if (this.retryRecording) {
        this.recordingUri = this.retryRecording.uri;
        this.capturedDraft = initiatingDraft;
        this.transcription = this.retryRecording.transcription;
        this.retryRecording = null;
        await this.finishRecording(true, this.recordingUri);
        return;
      }
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
      await this.dependencies.recorder.prepareToRecordAsync(abortController.signal);
      if (!this.isCurrent(operationToken)) return;
      this.recordingUri = this.dependencies.recorder.uri;
      this.rememberRecordingUri(this.recordingUri);

      const capturedDraft = this.dependencies.readDraft();
      if (!capturedDraft || capturedDraft.ownerKey !== initiatingDraft.ownerKey) {
        this.setError("This draft is no longer available.", "retry");
        return;
      }
      this.capturedDraft = capturedDraft;
      if (this.transcription.start && this.recordingUri) {
        const start = this.transcription.start;
        const uri = this.recordingUri;
        this.liveTranscription = runTranscriptionOperation(() =>
          start(uri, { signal: abortController.signal }),
        ).then(
          (text) => ({ text }),
          (error: unknown) => {
            if (this.isCurrent(operationToken) && this.state.phase === "recording") {
              void this.discardRecording(transcriptionErrorMessage(error));
            }
            return { error };
          },
        );
      }
      this.dependencies.recorder.record({ forDuration: VOICE_RECORDING_LIMIT_SECONDS });
      this.setState({ phase: "recording", error: null, errorAction: null });
    } catch (error) {
      if (this.isCurrent(operationToken))
        this.setError(
          isMicrophonePermissionError(error)
            ? MICROPHONE_PERMISSION_ERROR
            : "Could not start voice recording.",
          "retry",
        );
    } finally {
      if (sessionToken && this.sessionToken === sessionToken) {
        if (this.isCurrent(operationToken) && this.state.phase === "error") {
          await this.releaseResources();
        } else if (!this.isCurrent(operationToken) && !this.finishing) {
          await this.releaseResources();
        }
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
        this.retryRecording = null;
        this.deleteOwnedRecordings();
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
      case "post-processing":
        this.invalidateOperation();
        this.setState(IDLE_STATE);
        return;
    }
  }

  skipPostProcessing(): void {
    if (this.state.phase !== "post-processing") return;
    this.skipPostProcessingRequested = true;
    this.postProcessingAbortController?.abort();
  }

  interruptRecording(
    message = "Voice recording was interrupted.",
    completedUri: string | null = null,
  ): Promise<void> | void {
    if (this.state.phase === "preparing") {
      this.invalidateOperation();
      this.setError(message, "retry");
      return;
    }
    if (this.state.phase !== "recording") return;
    this.rememberRecordingUri(completedUri);
    this.recordingUri = completedUri ?? this.recordingUri;
    return this.discardRecording(message);
  }

  appMovedToBackground(): Promise<void> | void {
    return this.interruptRecording(
      this.state.phase === "preparing"
        ? "Voice input stopped when the app moved to the background."
        : undefined,
    );
  }

  handleRecorderStatus(status: VoiceRecorderStatus): Promise<void> | void {
    if (this.state.phase !== "recording") return;
    if (status.url && this.recordingUri && status.url !== this.recordingUri) return;
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
    switch (this.state.phase) {
      case "idle":
        return;
      case "error":
        this.cancel();
        return;
      case "recording":
        this.discardRecording(null);
        return;
      default:
        this.invalidateOperation();
        this.setState(IDLE_STATE);
    }
  }

  private async finishRecording(
    alreadyStopped: boolean,
    completedUri: string | null,
  ): Promise<void> {
    if (this.finishing || (this.state.phase !== "recording" && this.state.phase !== "preparing"))
      return;
    this.finishing = true;
    const operationToken = this.operationToken;
    this.setState({ phase: "transcribing", error: null, errorAction: null });

    try {
      if (!alreadyStopped) await this.dependencies.recorder.stop();
      await this.releaseAudioSession();
      this.recordingUri = completedUri ?? this.dependencies.recorder.uri ?? this.recordingUri;
      this.rememberRecordingUri(this.recordingUri);
      if (!this.isCurrent(operationToken)) return;
      const transcription = this.transcription;
      const recordingUri = this.recordingUri;
      if (
        !transcription ||
        (!transcription.streaming && !recordingUri) ||
        !this.transcriptionAbortController ||
        !this.capturedDraft
      ) {
        this.setError("Could not finish voice recording.", "retry");
        return;
      }

      const signal = this.transcriptionAbortController.signal;
      const capturedDraft = this.capturedDraft;
      let transcript: string;
      const transcribeRecording = () =>
        runTranscriptionOperation(() => transcription.transcribe(recordingUri!, { signal }));
      try {
        const live = this.liveTranscription ? await this.liveTranscription : null;
        if (live && "error" in live) throw live.error;
        const streaming = transcription.streaming;
        transcript =
          live?.text ??
          (streaming
            ? await runTranscriptionOperation(() => streaming.finish({ signal })).catch(
                (error: unknown) => {
                  // A failed live stream gets one pass over the retained recording.
                  if (!recordingUri || signal.aborted || !this.isCurrent(operationToken))
                    throw error;
                  return transcribeRecording();
                },
              )
            : await transcribeRecording());
      } catch (error) {
        if (this.isCurrent(operationToken)) {
          const retained =
            this.dependencies.retryFailedRecording && !this.liveTranscription && recordingUri;
          if (retained) {
            this.retryRecording = {
              uri: recordingUri,
              ownerKey: capturedDraft.ownerKey,
              transcription: { locale: transcription.locale, transcribe: transcription.transcribe },
            };
          }
          this.setError(
            retained ? RETAINED_RECORDING_ERROR : transcriptionErrorMessage(error),
            "retry",
          );
        }
        return;
      }
      if (!this.isCurrent(operationToken)) return;

      const postProcessingAbortController = new AbortController();
      const cleanup =
        transcript.trim().length > 0
          ? this.dependencies.postProcess?.(transcript, {
              signal: postProcessingAbortController.signal,
              draft: capturedDraft,
            })
          : null;
      if (cleanup) {
        this.setState({ phase: "post-processing", error: null, errorAction: null });
        this.postProcessingAbortController = postProcessingAbortController;
        this.skipPostProcessingRequested = false;
        const rawTranscript = transcript;
        try {
          // Skip resolves immediately with the raw transcript; the abort signal tells the
          // provider request to stop but its settlement is not awaited.
          transcript = await Promise.race([
            cleanup,
            new Promise<string>((resolve) =>
              postProcessingAbortController.signal.addEventListener(
                "abort",
                () => resolve(rawTranscript),
                { once: true },
              ),
            ),
          ]);
        } catch (error) {
          if (!this.skipPostProcessingRequested) {
            this.dependencies.onPostProcessingError?.(error);
          }
        }
        if (!this.isCurrent(operationToken)) return;
      }

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
    await this.releaseResources();
  }

  private async releaseResources(): Promise<void> {
    this.transcriptionAbortController?.abort();
    this.postProcessingAbortController?.abort();
    this.rememberRecordingUri(this.recordingUri);
    try {
      this.rememberRecordingUri(this.dependencies.recorder.uri);
    } catch {}
    if (this.recordingConfigured) {
      try {
        await this.dependencies.recorder.stop();
      } catch {}
    }
    await this.liveTranscription;
    this.liveTranscription = null;
    this.recordingUri = null;
    this.deleteOwnedRecordings();
    await this.releaseAudioSession();
    releaseSession(this.sessionToken);
    this.sessionToken = null;
    this.capturedDraft = null;
    this.transcription = null;
    this.transcriptionAbortController = null;
    this.postProcessingAbortController = null;
    this.skipPostProcessingRequested = false;
  }

  private deleteOwnedRecordings(): void {
    for (const uri of this.ownedRecordingUris) {
      if (uri === this.retryRecording?.uri) continue;
      try {
        this.dependencies.deleteRecording(uri);
      } catch {}
    }
    this.ownedRecordingUris.clear();
    if (this.retryRecording) this.ownedRecordingUris.add(this.retryRecording.uri);
  }

  private rememberRecordingUri(uri: string | null): void {
    if (uri) this.ownedRecordingUris.add(uri);
  }

  private async releaseAudioSession(): Promise<void> {
    if (!this.recordingConfigured) return;
    try {
      await this.dependencies.releaseRecording();
      this.recordingConfigured = false;
    } catch {}
  }

  private invalidateOperation(): void {
    this.operationToken += 1;
    if (this.sessionToken) this.sessionToken.abandoned = true;
    this.transcriptionAbortController?.abort();
    this.postProcessingAbortController?.abort();
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
