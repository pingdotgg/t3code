import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

type Selection = VoiceDraftSnapshot["selection"];
const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

type SessionSnapshot = {
  readonly ownerKey: string | null;
  readonly state: VoiceInputState;
  readonly selection: Selection | null;
};

/** Owns dictation independently of the screen displaying its draft. */
export class VoiceInputSession {
  private snapshot: SessionSnapshot = { ownerKey: null, state: IDLE_STATE, selection: null };
  private readonly listeners = new Set<() => void>();
  private draft: VoiceDraftSnapshot | null = null;
  readonly controller: VoiceInputController;

  constructor(
    private readonly dependencies: Omit<
      VoiceInputControllerDependencies,
      "readDraft" | "commitDraft" | "onStateChange"
    > & {
      readonly readText: (ownerKey: string) => string;
      readonly writeText: (ownerKey: string, text: string) => void;
    },
  ) {
    this.controller = new VoiceInputController({
      ...dependencies,
      readDraft: () => {
        this.draftChanged();
        return this.draft;
      },
      commitDraft: (text, selection) => {
        if (!this.draft) return;
        dependencies.writeText(this.draft.ownerKey, text);
        this.snapshot = { ...this.snapshot, selection };
      },
      onStateChange: (state) => {
        this.snapshot = { ...this.snapshot, state };
        this.listeners.forEach((listener) => listener());
      },
    });
  }

  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Deliver the completed transcript cursor once, to its owning composer. */
  takeSelection(ownerKey: string): Selection | null {
    if (this.snapshot.ownerKey !== ownerKey || !this.snapshot.selection) return null;
    const selection = this.snapshot.selection;
    this.snapshot = { ...this.snapshot, selection: null };
    this.listeners.forEach((listener) => listener());
    return selection;
  }

  /** Observe every draft mutation, including edits that restore the original text. */
  draftChanged(): void {
    if (!this.draft) return;
    const text = this.dependencies.readText(this.draft.ownerKey);
    if (text !== this.draft.text) {
      this.draft = { ...this.draft, text, revision: this.draft.revision + 1 };
      if (this.snapshot.selection) this.takeSelection(this.draft.ownerKey);
    }
  }

  async start(ownerKey: string, selection: Selection): Promise<boolean> {
    if (voiceInputBlocksSubmission(this.snapshot.state)) {
      return this.snapshot.ownerKey === ownerKey;
    }
    this.draft = {
      ownerKey,
      selection,
      text: this.dependencies.readText(ownerKey),
      revision: 0,
    };
    this.snapshot = { ownerKey, state: IDLE_STATE, selection: null };
    await this.controller.start();
    return true;
  }
}
