import { getActiveLocale, m } from "../../i18n/messages";
import {
  createEnvironmentReadAloud,
  createReadAloudController,
  type SpeechPlayback,
  type SpokenWord,
} from "@t3tools/client-runtime/read-aloud";
import { speakSpeechMath } from "@t3tools/client-runtime/voice-input";
import { markdownMathRanges } from "@t3tools/shared/markdownMath";
import { spokenWordAt, type SpeakMath } from "@t3tools/shared/read-aloud";
import { AsyncResult } from "effect/reactivity";
import { createAudioPlayer } from "expo-audio";
import * as Speech from "expo-speech";
import * as Option from "effect/Option";
import { AppState, Platform } from "react-native";
import type { EnvironmentId, ReadAloudSettings } from "@t3tools/contracts";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { environmentSession } from "../../state/session";
import { createAudioPlaybackSession, disposeAudioPlayer } from "../../lib/audioSession";
import { runSpeech } from "../voice-input/voiceDestination";

function pauseInBackground(settings: ReadAloudSettings) {
  const shouldPause = !settings.backgroundPlayback && AppState.currentState !== "active";
  if (shouldPause) readAloudController.pause();
  return shouldPause;
}

function watchForeground(settings: ReadAloudSettings) {
  const subscription = AppState.addEventListener("change", (state) => {
    if (!settings.backgroundPlayback && state !== "active") readAloudController.pause();
  });
  return () => subscription.remove();
}

function systemPlayback(text: string, settings: ReadAloudSettings): SpeechPlayback {
  let done: () => void = () => {};
  let fail: (error: Error) => void = () => {};
  const finished = new Promise<void>((resolve, reject) => {
    done = resolve;
    fail = reject;
  });
  let started = false;
  let offset = 0;
  let generation = 0;
  const listeners = new Set<(word: SpokenWord | null) => void>();
  const player = {
    play() {
      if (pauseInBackground(settings)) return;
      if (started && Platform.OS === "ios") {
        void Speech.resume().catch(fail);
        return;
      }
      started = true;
      const current = ++generation;
      const start = offset;
      Speech.speak(text.slice(start), {
        ...(settings.voice ? { voice: settings.voice } : {}),
        ...(settings.language !== "auto" ? { language: settings.language } : {}),
        rate: settings.speed,
        useApplicationAudioSession: true,
        onBoundary: (event: { charIndex: number }) => {
          if (current !== generation) return;
          offset = start + event.charIndex;
          const word = spokenWordAt(text, offset);
          for (const listener of listeners) listener(word);
        },
        onDone: () => {
          if (current === generation) done();
        },
        onError: (error) => {
          if (current === generation) fail(error);
        },
      });
    },
    pause() {
      if (Platform.OS === "ios") void Speech.pause().catch(fail);
      else {
        generation++;
        void Speech.stop().catch(fail);
      }
    },
  };
  const stopWatching = watchForeground(settings);
  const session = createAudioPlaybackSession(
    player,
    false,
    (requested) => {
      if (!requested) readAloudController.pause();
    },
    settings.backgroundPlayback,
  );
  return {
    play: async () => {
      if (pauseInBackground(settings)) return;
      if (!(await session.play())) throw new Error("Finish recording before reading aloud.");
    },
    pause: () => session.pause(),
    stop: () => {
      stopWatching();
      session.pause();
      generation++;
      void Speech.stop().catch(() => {});
      done();
    },
    finished,
    words: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const connection = (environmentId: EnvironmentId) =>
  Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
const environmentReadAloud = createEnvironmentReadAloud({ connection, run: runSpeech });

export const warmReadAloud = environmentReadAloud.warm;

/**
 * Words for the reply's formulas when replies render math, as screen readers say them. React Native
 * cannot run Speech Rule Engine, so the read-aloud environment reads them; without math rendering,
 * or without an environment, the reply's TeX is what is read.
 */
function prepareReadAloudMath(markdown: string): Promise<SpeakMath> | undefined {
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  if (!AsyncResult.isSuccess(preferences) || !preferences.value.mathRenderingEnabled)
    return undefined;
  const environmentId = preferences.value.readAloud?.environmentId;
  const prepared = environmentId ? connection(environmentId) : null;
  const formulas = markdownMathRanges(markdown);
  if (!prepared || formulas.length === 0) return undefined;
  return runSpeech(speakSpeechMath(prepared, formulas, getActiveLocale())).then(
    ({ words }) => {
      const spoken = new Map(formulas.map((formula, index) => [formula.tex, words[index]]));
      return (tex: string) => spoken.get(tex) ?? undefined;
    },
    // An environment without formula speech reads the TeX, as the reply would without rendering.
    () => () => undefined,
  );
}

export const readAloudController = createReadAloudController(
  async (text, settings, signal, from) => {
    if (settings.provider === "system") {
      const voices =
        settings.voice || Platform.OS === "android" ? await Speech.getAvailableVoicesAsync() : [];
      signal.throwIfAborted();
      return systemPlayback(text, {
        ...settings,
        voice: voices.some((voice) => voice.identifier === settings.voice) ? settings.voice : "",
      });
    }
    const speech = await environmentReadAloud.start(text, settings, signal, from);
    const player = createAudioPlayer(speech.url, { updateInterval: 500 });
    if (speech.rate(settings.speed) !== 1) player.setPlaybackRate(speech.rate(settings.speed));
    // Where in the speech the player's audio starts: Android opens it again to seek.
    let opensAt = 0;
    const stopWatching = watchForeground(settings);
    const session = createAudioPlaybackSession(
      {
        play() {
          if (!pauseInBackground(settings)) player.play();
        },
        pause: (deactivateSession) => player.pause(deactivateSession),
      },
      false,
      (requested, reason) => {
        if (!requested) {
          if (reason !== "pause") player.setActiveForLockScreen(false);
          readAloudController.pause();
        }
      },
      settings.backgroundPlayback,
      // Native lock-screen Play bypasses JS, so a paused player must keep revocable ownership.
      settings.backgroundPlayback,
    );
    let timed: ReturnType<typeof speech.timedWords> | null = null;
    // The environment measures the loudness: iOS cannot tap a stream of unknown length, and
    // Android samples only with the microphone permission.
    const timedWords = () =>
      (timed ??= speech.timedWords(
        () => ({
          seconds: opensAt + player.currentTime,
          rate: player.playbackRate,
          playing: player.playing,
        }),
        true,
      ));
    let done: () => void = () => {};
    const finished = new Promise<void>((resolve, reject) => {
      done = resolve;
      player.addListener("playbackStatusUpdate", (status) => {
        timed?.refresh();
        if (status.didJustFinish) resolve();
        else if (status.error) reject(new Error("Could not play the generated speech."));
        else if (
          status.playing &&
          session.requested &&
          readAloudController.getSnapshot().status === "paused"
        )
          void readAloudController.resume();
        else if (
          session.requested &&
          status.isLoaded &&
          status.duration > 0 &&
          status.currentTime < status.duration &&
          !status.playing &&
          !status.isBuffering &&
          status.timeControlStatus === "paused" &&
          readAloudController.getSnapshot().status === "playing"
        )
          readAloudController.pause();
      });
    });
    return {
      play: async () => {
        if (pauseInBackground(settings)) return;
        if (settings.backgroundPlayback)
          player.setActiveForLockScreen(true, { title: "T3 Code", artist: "Read aloud" });
        if (!(await session.play())) throw new Error("Finish recording before reading aloud.");
      },
      pause: () => session.pause(),
      stop: () => {
        timed?.stop();
        stopWatching();
        session.stop();
        disposeAudioPlayer(player);
        done();
      },
      finished,
      words: (listener) => timedWords().subscribe(listener),
      seek: (at) => {
        const seconds = timed?.secondsAt(at);
        if (seconds === undefined) return false;
        if (Platform.OS === "android") {
          // ExoPlayer cannot seek a stream of unknown length; the environment opens it there.
          opensAt = seconds;
          player.replace(speech.urlAt(seconds));
          timed?.refresh();
        } else
          void player.seekTo(seconds).then(
            () => timed?.refresh(),
            () => {},
          );
        return true;
      },
      setSpeed: (speed) => {
        player.setPlaybackRate(speech.rate(speed));
        timed?.refresh();
      },
      levels: (listener) => timedWords().followLevels(listener),
    };
  },
  m,
  prepareReadAloudMath,
);
