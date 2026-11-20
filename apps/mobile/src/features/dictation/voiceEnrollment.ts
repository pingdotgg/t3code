import { msg } from "gt-react-native";
import { m } from "../../i18n/messages";
import { nativeErrorMessage } from "./dictationDownloads";
import type { DictationNativeModule } from "./dictationNative";

export const ENROLLMENT_CLIP_COUNT = 3;
export const ENROLLMENT_CLIP_LIMIT_SECONDS = 20;

export const ENROLLMENT_PROMPTS: ReadonlyArray<string> = [
  "When I dictate a message, I speak the way I normally do, at my usual pace and volume, so the app can learn what my voice sounds like.",
  "The quick brown fox jumps over the lazy dog while seven wizards quietly judge a boxing match down by the river.",
  "Open the pull request, check the failing test, and tell me which file needs to change before we ship this on Friday.",
];

export interface EnrollmentRecording {
  /** Stops and gives the recording's file, or null when nothing was captured. */
  stop(): Promise<string | null>;
}

export interface VoiceEnrollmentDeps {
  readonly native: Pick<DictationNativeModule, "checkEnrollmentClip" | "saveVoiceProfile">;
  /** Starts a recording. Rejects with the message to show. `onLimit` runs at the length limit. */
  readonly record: (onLimit: () => void) => Promise<EnrollmentRecording>;
  readonly deleteFile: (uri: string) => void;
  readonly onSaved: () => void;
}

export interface VoiceEnrollmentSnapshot {
  readonly phase: "idle" | "starting" | "recording" | "checking" | "saving";
  /** Samples accepted so far, which is also the index of the prompt to read next. */
  readonly accepted: number;
  /** Why the last sample or the profile was turned down. */
  readonly message: string | null;
}

export interface VoiceEnrollment {
  getSnapshot(): VoiceEnrollmentSnapshot;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Drops the recording in progress and every accepted sample. */
  reset(): void;
}

const IDLE: VoiceEnrollmentSnapshot = { phase: "idle", accepted: 0, message: null };

/** Records the samples one at a time, checks each, and saves the voice profile after the last. */
export function createVoiceEnrollment(deps: VoiceEnrollmentDeps): VoiceEnrollment {
  let snapshot = IDLE;
  let clips: string[] = [];
  let recording: EnrollmentRecording | null = null;
  // Bumped by reset(); work that started before it throws its result away.
  let run = 0;
  const listeners = new Set<() => void>();

  const set = (change: Partial<VoiceEnrollmentSnapshot>) => {
    snapshot = { ...snapshot, ...change };
    for (const listener of listeners) listener();
  };
  const discard = (uris: ReadonlyArray<string>) => {
    for (const uri of uris) {
      try {
        deps.deleteFile(uri);
      } catch {
        // A file already gone needs no deleting.
      }
    }
  };
  const abandon = (stale: EnrollmentRecording) =>
    void stale.stop().then(
      (uri) => discard(uri === null ? [] : [uri]),
      () => {},
    );

  async function start() {
    if (snapshot.phase !== "idle") return;
    const mine = run;
    set({ phase: "starting", message: null });
    let started: EnrollmentRecording;
    try {
      started = await deps.record(() => void stop());
    } catch (error) {
      if (mine === run) {
        set({ phase: "idle", message: nativeErrorMessage(error, "Recording could not start.") });
      }
      return;
    }
    if (mine !== run) return abandon(started);
    recording = started;
    set({ phase: "recording" });
  }

  async function stop() {
    if (snapshot.phase !== "recording" || recording === null) return;
    const mine = run;
    const active = recording;
    recording = null;
    set({ phase: "checking" });
    const uri = await active.stop().catch(() => null);
    if (mine !== run) return discard(uri === null ? [] : [uri]);
    if (uri === null)
      return set({ phase: "idle", message: m(msg("The recording failed. Try again.")) });

    const problem = await deps.native.checkEnrollmentClip(uri).then(
      (check) => (check.problem === null ? null : (check.message ?? "Record that sample again.")),
      (error: unknown) => nativeErrorMessage(error, "The recording could not be checked."),
    );
    if (mine !== run) return discard([uri]);
    if (problem !== null) {
      discard([uri]);
      return set({ phase: "idle", message: problem });
    }
    clips.push(uri);
    if (clips.length < ENROLLMENT_CLIP_COUNT) {
      return set({ phase: "idle", accepted: clips.length });
    }

    const saving = clips;
    clips = [];
    set({ phase: "saving", accepted: saving.length });
    const failure = await deps.native.saveVoiceProfile(saving).then(
      () => null,
      (error: unknown) => nativeErrorMessage(error, "The voice profile could not be saved."),
    );
    discard(saving);
    if (mine !== run) return;
    set({ phase: "idle", accepted: 0, message: failure });
    if (failure === null) deps.onSaved();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    stop,
    reset() {
      run += 1;
      if (recording !== null) abandon(recording);
      recording = null;
      discard(clips);
      clips = [];
      set(IDLE);
    },
  };
}
