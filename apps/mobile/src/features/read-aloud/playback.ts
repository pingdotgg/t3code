import { uuidv4 } from "../../lib/uuid";
import { createReadAloudController, type SpeechPlayback } from "@t3tools/client-runtime/read-aloud";
import { synthesizeSpeech } from "@t3tools/client-runtime/voice-input";
import { speechAudioMimeType } from "@t3tools/shared/read-aloud";
import { createAudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import * as Speech from "expo-speech";
import * as Option from "effect/Option";
import { AppState, Platform } from "react-native";
import type { ReadAloudSettings } from "@t3tools/contracts";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/session";
import { createAudioPlaybackSession, disposeAudioPlayer } from "../../lib/audioSession";
import { runSpeech } from "../voice-input/voiceDestination";

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
  const player = {
    play() {
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
          if (current === generation) offset = start + event.charIndex;
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
      if (!settings.backgroundPlayback && AppState.currentState !== "active") {
        readAloudController.pause();
        return;
      }
      await session.play();
      if (!session.requested) throw new Error("Finish recording before reading aloud.");
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
  };
}

export const readAloudController = createReadAloudController(async (text, settings, signal) => {
  if (settings.provider === "system") {
    const voices =
      settings.voice || Platform.OS === "android" ? await Speech.getAvailableVoicesAsync() : [];
    signal.throwIfAborted();
    return systemPlayback(text, {
      ...settings,
      voice: voices.some((voice) => voice.identifier === settings.voice) ? settings.voice : "",
    });
  }
  if (settings.provider === "off") throw new Error("Enable read aloud in Settings → Voice.");
  const prepared = settings.environmentId
    ? Option.getOrNull(
        appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(settings.environmentId)),
      )
    : null;
  if (!prepared)
    throw new Error("Connect to the read-aloud environment selected in Settings → Voice.");
  const bytes = await runSpeech(
    synthesizeSpeech(prepared, settings.provider, {
      text,
      model: settings.model,
      voice: settings.voice,
      speed: settings.speed,
      language: settings.language,
    }),
    signal,
  );
  signal.throwIfAborted();
  const mimeType = speechAudioMimeType(bytes);
  const file = new File(
    Paths.cache,
    `t3-speech-${uuidv4()}.${mimeType === "audio/wav" ? "wav" : mimeType === "audio/aac" ? "aac" : "mp3"}`,
  );
  let player: ReturnType<typeof createAudioPlayer>;
  try {
    file.write(bytes);
    player = createAudioPlayer(file.uri, { updateInterval: 500 });
    if (settings.provider === "chatgpt" || settings.provider === "openrouter")
      player.setPlaybackRate(settings.speed);
  } catch {
    if (file.exists) file.delete();
    throw new Error("Could not prepare the generated speech for playback.");
  }
  const stopWatching = watchForeground(settings);
  const session = createAudioPlaybackSession(
    player,
    false,
    (requested) => {
      if (!requested) {
        player.setActiveForLockScreen(false);
        readAloudController.pause();
      }
    },
    settings.backgroundPlayback,
  );
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve, reject) => {
    done = resolve;
    player.addListener("playbackStatusUpdate", (status) => {
      if (status.didJustFinish) resolve();
      else if (status.error) reject(new Error("Could not play the generated speech."));
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
      if (!settings.backgroundPlayback && AppState.currentState !== "active") {
        readAloudController.pause();
        return;
      }
      if (settings.backgroundPlayback)
        player.setActiveForLockScreen(true, { title: "T3 Code", artist: "Read aloud" });
      await session.play();
      if (!session.requested) throw new Error("Finish recording before reading aloud.");
    },
    pause: () => session.pause(),
    stop: () => {
      stopWatching();
      session.pause();
      disposeAudioPlayer(player);
      if (file.exists) file.delete();
      done();
    },
    finished,
  };
});
