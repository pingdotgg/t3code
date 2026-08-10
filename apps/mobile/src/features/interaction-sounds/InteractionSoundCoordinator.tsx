import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  observeThreadSoundState,
  shouldPlayInteractionSound,
  type InteractionSoundCue,
  type ThreadSoundStateByKey,
} from "@t3tools/client-runtime/interaction-sounds";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAudioPlayer } from "expo-audio";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef } from "react";

import { mobilePreferencesAtom } from "../../state/preferences";
import { liveEnvironmentIdsAtom } from "../../state/shell";
import { useThreadRefs, useThreadShell } from "../../state/entities";
import { replayInteractionSound } from "./interactionSoundPlayback";

const SUCCESS_SOUND = require("../../../assets/interaction-sounds/success.wav");
const BLOOM_SOUND = require("../../../assets/interaction-sounds/bloom.wav");

type InteractionSoundPlayers = Readonly<
  Record<InteractionSoundCue, ReturnType<typeof useAudioPlayer>>
>;

export function InteractionSoundCoordinator() {
  const threadRefs = useThreadRefs();
  const liveEnvironmentIds = useAtomValue(liveEnvironmentIdsAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const successPlayer = useAudioPlayer(SUCCESS_SOUND);
  const bloomPlayer = useAudioPlayer(BLOOM_SOUND);
  const previouslyLiveEnvironmentIdsRef = useRef(new Set<ScopedThreadRef["environmentId"]>());
  const players = useMemo<InteractionSoundPlayers>(
    () => ({ bloom: bloomPlayer, success: successPlayer }),
    [bloomPlayer, successPlayer],
  );
  const settingsHydrated = AsyncResult.isSuccess(preferences);
  const completionSoundEnabled = settingsHydrated
    ? preferences.value.completionSoundEnabled !== false
    : true;

  useEffect(() => {
    for (const environmentId of liveEnvironmentIds) {
      previouslyLiveEnvironmentIdsRef.current.add(environmentId);
    }
  }, [liveEnvironmentIds]);

  return threadRefs.map((threadRef) => (
    <InteractionSoundThreadCoordinator
      key={scopedThreadKey(threadRef)}
      threadRef={threadRef}
      environmentLive={liveEnvironmentIds.has(threadRef.environmentId)}
      environmentPreviouslyLive={previouslyLiveEnvironmentIdsRef.current.has(
        threadRef.environmentId,
      )}
      completionSoundEnabled={completionSoundEnabled}
      settingsHydrated={settingsHydrated}
      players={players}
    />
  ));
}

function InteractionSoundThreadCoordinator({
  threadRef,
  environmentLive,
  environmentPreviouslyLive,
  completionSoundEnabled,
  settingsHydrated,
  players,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly environmentLive: boolean;
  readonly environmentPreviouslyLive: boolean;
  readonly completionSoundEnabled: boolean;
  readonly settingsHydrated: boolean;
  readonly players: InteractionSoundPlayers;
}) {
  const thread = useThreadShell(threadRef);
  const previousStateRef = useRef<ThreadSoundStateByKey | null>(null);
  const environmentObservedLiveRef = useRef(environmentPreviouslyLive);

  useEffect(() => {
    if (thread === null) {
      return;
    }
    const environmentWasLive = environmentObservedLiveRef.current || environmentPreviouslyLive;
    const observation = observeThreadSoundState(previousStateRef.current, thread, {
      environmentLive,
      environmentPreviouslyLive: environmentWasLive,
      settingsHydrated,
    });
    if (environmentLive || environmentPreviouslyLive) {
      environmentObservedLiveRef.current = true;
    }
    previousStateRef.current = observation.state;
    for (const cue of observation.cues) {
      if (shouldPlayInteractionSound(cue, completionSoundEnabled)) {
        void replayInteractionSound(players[cue]).catch((error: unknown) => {
          console.warn(`[interaction-sounds] Could not play ${cue} cue.`, error);
        });
      }
    }
  }, [
    completionSoundEnabled,
    environmentLive,
    environmentPreviouslyLive,
    players,
    settingsHydrated,
    thread,
  ]);

  return null;
}
