import {
  VOICE_RECORDING_LIMIT_SECONDS,
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceInputPhase,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";

const VOICE_METERING_INTERVAL_MS = 80;
const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const SILENT_LEVELS: ReadonlyArray<number> = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);

export type VoiceInputTarget = {
  readonly ownerKey: string;
  readonly label?: string;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: VoiceInputControllerDependencies["commitDraft"];
  readonly subscribe: () => () => void;
};

export type VoiceInputSnapshot = {
  readonly state: VoiceInputState;
  readonly ownerKey: string | null;
  readonly label: string | null;
  readonly elapsedSeconds: number;
  readonly focusedOwners: ReadonlySet<string>;
};

export type VoiceRecordingSample = {
  readonly durationMillis: number;
  readonly metering: number | undefined;
};

export type VoiceInputSessionDependencies = Omit<
  VoiceInputControllerDependencies,
  "readDraft" | "commitDraft" | "onStateChange"
> & {
  /** Reads the live recorder, or null when it is not capturing. */
  readonly sampleRecording: () => VoiceRecordingSample | null;
  /** Levels change every metering tick, so they bypass React state. */
  readonly publishAudioLevels: (levels: ReadonlyArray<number>) => void;
  /** Holds the screen awake while recording; returns the release. */
  readonly keepAwake: () => () => void;
};

export function createVoiceInputTarget(
  ownerKey: string,
  readText: () => string | null,
  commitDraft: VoiceInputTarget["commitDraft"],
  selection: VoiceDraftSnapshot["selection"],
  subscribeToChanges: (onChange: () => void) => () => void,
): VoiceInputTarget {
  let revision = 0;
  return {
    ownerKey,
    readDraft: () => {
      const text = readText();
      if (text === null) return null;
      return { ownerKey, text, selection, revision };
    },
    commitDraft,
    subscribe: () => {
      let previousText = readText();
      return subscribeToChanges(() => {
        const text = readText();
        if (text !== previousText) {
          previousText = text;
          revision += 1;
        }
      });
    },
  };
}

/**
 * The app's single voice input: it owns the controller, the recording-only
 * side effects (keep-awake, metering) and publishes what the UI renders.
 */
export class VoiceInputSession {
  readonly controller: VoiceInputController;
  private readonly dependencies: VoiceInputSessionDependencies;
  private target: VoiceInputTarget | null = null;
  private unsubscribe: (() => void) | null = null;
  private snapshot: VoiceInputSnapshot = {
    state: IDLE_STATE,
    ownerKey: null,
    label: null,
    elapsedSeconds: 0,
    focusedOwners: new Set(),
  };
  private readonly listeners = new Set<() => void>();
  private audioLevels = SILENT_LEVELS;
  private releaseKeepAwake: (() => void) | null = null;
  private meteringInterval: ReturnType<typeof setInterval> | null = null;

  constructor(dependencies: VoiceInputSessionDependencies) {
    this.dependencies = dependencies;
    this.controller = new VoiceInputController({
      ...dependencies,
      onStateChange: (state) => this.handleStateChange(state),
      readDraft: () => this.target?.readDraft() ?? null,
      commitDraft: (text, selection) => this.target?.commitDraft(text, selection),
    });
  }

  get ownerKey(): string | null {
    return this.target?.ownerKey ?? null;
  }

  get label(): string | null {
    return this.target?.label ?? null;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): VoiceInputSnapshot => this.snapshot;

  setOwnerFocused(ownerKey: string, focused: boolean): void {
    if (this.snapshot.focusedOwners.has(ownerKey) === focused) return;
    const focusedOwners = new Set(this.snapshot.focusedOwners);
    if (focused) focusedOwners.add(ownerKey);
    else focusedOwners.delete(ownerKey);
    this.publish({ ...this.snapshot, focusedOwners });
  }

  cancel(ownerKey: string | null): void {
    if (ownerKey !== null && this.ownerKey === ownerKey) this.controller.cancel();
  }

  retry(): Promise<void> {
    return this.target ? this.start(this.target) : Promise.resolve();
  }

  start(target: VoiceInputTarget): Promise<void> {
    if (voiceInputBlocksSubmission(this.controller.currentState)) return Promise.resolve();
    this.target = target;
    this.unsubscribe = target.subscribe();
    return this.controller.start();
  }

  dispose(): void {
    this.controller.dispose();
    this.stopRecordingActivity();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }

  private handleStateChange(state: VoiceInputState): void {
    if (!voiceInputBlocksSubmission(state)) {
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
    const previousPhase = this.snapshot.state.phase;
    let elapsedSeconds = this.snapshot.elapsedSeconds;
    if (state.phase !== previousPhase) {
      if (previousPhase === "recording") this.stopRecordingActivity();
      if (capturesAudio(state.phase)) {
        if (this.audioLevels.some((level) => level !== 0)) this.setAudioLevels(SILENT_LEVELS);
        elapsedSeconds = 0;
      }
    }
    this.publish({
      ...this.snapshot,
      state,
      ownerKey: this.ownerKey,
      label: this.label,
      elapsedSeconds,
    });
    if (state.phase === "recording" && previousPhase !== "recording") {
      this.startRecordingActivity();
    }
  }

  private startRecordingActivity(): void {
    this.releaseKeepAwake = this.dependencies.keepAwake();
    this.sampleRecording();
    this.meteringInterval = setInterval(() => this.sampleRecording(), VOICE_METERING_INTERVAL_MS);
  }

  private stopRecordingActivity(): void {
    if (this.meteringInterval !== null) clearInterval(this.meteringInterval);
    this.meteringInterval = null;
    this.releaseKeepAwake?.();
    this.releaseKeepAwake = null;
  }

  private sampleRecording(): void {
    if (this.controller.currentState.phase !== "recording") return;
    const sample = this.dependencies.sampleRecording();
    if (!sample) return;

    const level = normalizeVoiceInputDecibels(sample.metering);
    if (level !== 0 || this.audioLevels.some((sample) => sample !== 0)) {
      this.setAudioLevels([...this.audioLevels.slice(1), level]);
    }

    const elapsedSeconds = Math.min(
      VOICE_RECORDING_LIMIT_SECONDS,
      Math.max(0, Math.floor(sample.durationMillis / 1_000)),
    );
    if (elapsedSeconds !== this.snapshot.elapsedSeconds) {
      this.publish({ ...this.snapshot, elapsedSeconds });
    }
  }

  private setAudioLevels(levels: ReadonlyArray<number>): void {
    this.audioLevels = levels;
    this.dependencies.publishAudioLevels(levels);
  }

  private publish(snapshot: VoiceInputSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function capturesAudio(phase: VoiceInputPhase): boolean {
  return phase === "preparing" || phase === "recording";
}
