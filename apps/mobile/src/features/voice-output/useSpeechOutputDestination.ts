import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { SpeechPlaybackRate, SpeechOutputDestination } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import * as Dialog from "../../components/ui/Dialog";
import { voiceOutput } from "./voiceOutput";

export function useSpeechOutputDestination() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const destination = AsyncResult.isSuccess(preferences)
    ? (preferences.value.speechOutputDestination ?? null)
    : null;
  const playbackRate = AsyncResult.isSuccess(preferences)
    ? (preferences.value.speechPlaybackRate ?? 1)
    : 1;
  const setPlaybackRate = (rate: SpeechPlaybackRate) => {
    voiceOutput.setPlaybackRate(rate);
    void save({ speechPlaybackRate: rate });
  };
  const choose = (destination: SpeechOutputDestination | null) => {
    voiceOutput.stop();
    void save({ speechOutputDestination: destination }).catch(() => {
      Dialog.alert(
        "Could not save speech output choice",
        "Your previous destination is still selected. Please try again.",
      );
    });
  };
  return { destination, choose, playbackRate, setPlaybackRate };
}
