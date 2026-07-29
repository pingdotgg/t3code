import { useAtomValue } from "@effect/atom-react";
import {
  captureThreadSoundState,
  captureThreadSoundStateWhileSettingsHydrating,
  deriveInteractionSoundCues,
  selectLiveThreadShells,
  shouldPlayInteractionSound,
  type InteractionSoundCue,
  type ThreadSoundStateByKey,
} from "@t3tools/client-runtime/interaction-sounds";
import { useAudioPlayer } from "expo-audio";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef } from "react";

import { mobilePreferencesAtom } from "../../state/preferences";
import { liveEnvironmentIdsAtom } from "../../state/shell";
import { useThreadShells } from "../../state/entities";
import { replayInteractionSound } from "./interactionSoundPlayback";

const SUCCESS_SOUND = require("../../../assets/interaction-sounds/success.wav");
const BLOOM_SOUND = require("../../../assets/interaction-sounds/bloom.wav");

type InteractionSoundPlayers = Readonly<
  Record<InteractionSoundCue, ReturnType<typeof useAudioPlayer>>
>;

export function InteractionSoundCoordinator() {
  const threads = useThreadShells();
  const liveEnvironmentIds = useAtomValue(liveEnvironmentIdsAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const successPlayer = useAudioPlayer(SUCCESS_SOUND);
  const bloomPlayer = useAudioPlayer(BLOOM_SOUND);
  const previousStateRef = useRef<ThreadSoundStateByKey | null>(null);
  const liveThreads = useMemo(
    () => selectLiveThreadShells(threads, liveEnvironmentIds),
    [liveEnvironmentIds, threads],
  );
  const players = useMemo<InteractionSoundPlayers>(
    () => ({ bloom: bloomPlayer, success: successPlayer }),
    [bloomPlayer, successPlayer],
  );

  useEffect(() => {
    if (!AsyncResult.isSuccess(preferences)) {
      previousStateRef.current = captureThreadSoundStateWhileSettingsHydrating(
        previousStateRef.current,
        liveThreads,
      );
      return;
    }

    const previous = previousStateRef.current;
    if (previous !== null) {
      const completionSoundEnabled = preferences.value.completionSoundEnabled !== false;
      for (const cue of deriveInteractionSoundCues(previous, liveThreads)) {
        if (!shouldPlayInteractionSound(cue, completionSoundEnabled)) {
          continue;
        }
        void replayInteractionSound(players[cue]).catch((error: unknown) => {
          console.warn(`[interaction-sounds] Could not play ${cue} cue.`, error);
        });
      }
    }
    previousStateRef.current = captureThreadSoundState(liveThreads);
  }, [liveThreads, players, preferences]);

  return null;
}
