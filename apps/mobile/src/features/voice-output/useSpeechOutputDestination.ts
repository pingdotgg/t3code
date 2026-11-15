import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { SpeechOutputDestination } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { voiceOutput } from "./voiceOutput";

export function useSpeechOutputDestination() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const destination = AsyncResult.isSuccess(preferences)
    ? (preferences.value.speechOutputDestination ?? null)
    : null;
  const choose = (destination: SpeechOutputDestination | null) => {
    voiceOutput.stop();
    void save({ speechOutputDestination: destination });
  };
  return { destination, choose };
}
