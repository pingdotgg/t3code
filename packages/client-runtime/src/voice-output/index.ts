import type { SpeechOutputDestination, SpeechPlaybackRate } from "@t3tools/contracts";

export { VoiceOutputController, type SpeechAudioPlayer } from "./controller.ts";

export type NativeSpeechRequest = { readonly text: string; readonly voice: string | null };

export { speechPlaybackSelection } from "./preferences.ts";

export type SpeechPlaybackControls = {
  readonly mixedDestination?: boolean;
  readonly mixedTarget?: boolean;
  readonly mixedRate?: boolean;
  readonly destination: SpeechOutputDestination | null;
  readonly playbackRate: SpeechPlaybackRate;
  readonly choose: (destination: SpeechOutputDestination | null) => void;
  readonly setPlaybackRate: (rate: SpeechPlaybackRate) => void;
  readonly selectVoice: (voice: string | null) => void;
  readonly canManage: boolean;
};
