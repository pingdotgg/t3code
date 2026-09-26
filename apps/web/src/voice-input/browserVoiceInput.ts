import {
  resolveTranscriptCommit,
  VOICE_RECORDING_LIMIT_SECONDS,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

/** The subset of the browser Web Speech API used by the composer. */
export interface BrowserSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult:
    | ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechConstructor = new () => BrowserSpeechRecognition;

export function browserVoiceSupport(): {
  create: (() => BrowserSpeechRecognition) | null;
  unavailableReason: string | null;
} {
  if (typeof window === "undefined") return { create: null, unavailableReason: null };
  if (window.desktopBridge) {
    return {
      create: null,
      unavailableReason:
        "Voice input is available in supported web browsers. Desktop speech recognition is not supported yet.",
    };
  }
  if (!window.isSecureContext) {
    return { create: null, unavailableReason: "Voice input requires HTTPS or localhost." };
  }
  const browser = window as Window & {
    SpeechRecognition?: SpeechConstructor;
    webkitSpeechRecognition?: SpeechConstructor;
  };
  const Recognition = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
  return Recognition
    ? { create: () => new Recognition(), unavailableReason: null }
    : {
        create: null,
        unavailableReason: "This browser does not support voice input. Try Chrome or Safari.",
      };
}

const idle: VoiceInputState = { phase: "idle", error: null, errorAction: null };
let activeController: BrowserVoiceInputController | null = null;

function recognitionError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone or speech recognition access was denied. Check your browser permissions.";
    case "audio-capture":
      return "No microphone is available. Check your audio input.";
    case "no-speech":
      return "No speech was detected. Try again.";
    case "network":
      return "The browser's speech service could not be reached. Check your connection and try again.";
    case "language-not-supported":
      return "Speech recognition does not support your browser language.";
    default:
      return "Voice input failed. Your draft has not changed.";
  }
}

/** Owns one recognition session; late events can never write to another draft. */
export class BrowserVoiceInputController {
  private recognition: BrowserSpeechRecognition | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state = idle;

  constructor(
    private readonly dependencies: {
      create: () => BrowserSpeechRecognition;
      readDraft: () => VoiceDraftSnapshot;
      commit: (text: string, cursor: number, sendImmediately: boolean) => void;
      onState: (state: VoiceInputState) => void;
    },
  ) {}

  get busy() {
    return this.recognition !== null;
  }

  start(locale: string, sendImmediately: boolean): void {
    if (this.busy) return;
    if (activeController) {
      this.fail("Another voice recording is already active.");
      return;
    }
    const captured = this.dependencies.readDraft();
    let transcript = "";
    try {
      const recognition = this.dependencies.create();
      this.recognition = recognition;
      activeController = this;
      const current = () => this.recognition === recognition;
      recognition.lang = locale;
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.onstart = () => {
        if (current() && this.state.phase === "preparing") this.update("recording");
      };
      recognition.onresult = (event) => {
        if (!current()) return;
        // Results contain the whole session. Rebuild instead of appending so
        // repeated result events cannot duplicate words.
        transcript = Array.from(event.results)
          .filter((result) => result.isFinal)
          .map((result) => result[0].transcript)
          .join("");
      };
      recognition.onerror = (event) => {
        if (current()) this.fail(recognitionError(event.error));
      };
      recognition.onend = () => {
        if (!current()) return;
        const result = resolveTranscriptCommit(
          captured,
          this.dependencies.readDraft(),
          transcript,
          locale,
        );
        this.release(false);
        if (result.kind !== "commit") {
          this.fail(
            result.kind === "empty"
              ? "No speech was detected. Try again."
              : "The draft changed during voice input. The transcript was not added.",
          );
          return;
        }
        this.update("idle");
        this.dependencies.commit(result.text, result.selection.end, sendImmediately);
      };
      this.update("preparing");
      this.timer = setTimeout(() => this.stop(), VOICE_RECORDING_LIMIT_SECONDS * 1_000);
      recognition.start();
    } catch {
      this.fail("Could not start voice input. Check your browser's microphone permissions.");
    }
  }

  stop(): void {
    if (!this.recognition || this.state.phase === "transcribing") return;
    this.update("transcribing");
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.fail("Speech recognition did not finish. Your draft has not changed."),
      15_000,
    );
    try {
      this.recognition.stop();
    } catch {
      this.fail("Could not finish voice input. Your draft has not changed.");
    }
  }

  cancel(): void {
    this.release(true);
    this.update("idle");
  }

  private release(abort: boolean): void {
    const recognition = this.recognition;
    this.recognition = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (activeController === this) activeController = null;
    if (!recognition) return;
    recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
    if (abort) {
      try {
        recognition.abort();
      } catch {
        /* The browser may already have ended the session. */
      }
    }
  }

  private update(phase: VoiceInputState["phase"]): void {
    this.state = { phase, error: null, errorAction: null };
    this.dependencies.onState(this.state);
  }

  private fail(error: string): void {
    this.release(true);
    this.state = { phase: "error", error, errorAction: "retry" };
    this.dependencies.onState(this.state);
  }
}
