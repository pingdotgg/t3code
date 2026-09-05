import { useIsFocused } from "@react-navigation/native";
import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AppState } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  VOICE_RECORDING_LIMIT_SECONDS,
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSessionContext } from "./VoiceInputProvider";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const VOICE_METERING_INTERVAL_MS = 80;

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
}) {
  const context = useContext(VoiceInputSessionContext);
  if (!context) throw new Error("VoiceInputProvider is missing");
  const { session, recorder } = context;
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const ownsSession = snapshot.ownerKey === input.ownerKey;
  const state = ownsSession ? snapshot.state : INITIAL_STATE;
  const controller = session.controller;
  const isFocused = useIsFocused();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const elapsedSecondsRef = useRef(0);
  const audioLevelsRef = useRef(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const audioLevels = useSharedValue(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const latestInputRef = useRef(input);
  useEffect(() => {
    latestInputRef.current = input;
  });
  useEffect(() => {
    if (!isFocused || !input.ownerKey || !ownsSession || !snapshot.selection) return;
    const selection = session.takeSelection(input.ownerKey);
    if (selection) latestInputRef.current.onChangeSelection(selection);
  }, [isFocused, input.ownerKey, ownsSession, session, snapshot.selection]);

  useEffect(() => {
    if (!isFocused || !ownsSession) return;
    if (state.phase !== "preparing" && state.phase !== "recording") return;

    if (audioLevelsRef.current.some((level) => level !== 0)) {
      audioLevelsRef.current = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);
      audioLevels.set(audioLevelsRef.current);
    }
    if (elapsedSecondsRef.current !== 0) {
      elapsedSecondsRef.current = 0;
      setElapsedSeconds(0);
    }
    if (state.phase !== "recording") return;

    const sampleRecording = () => {
      if (controller.currentState.phase !== "recording") return;
      const status = recorder.getStatus();
      if (!status.isRecording) return;

      const level = normalizeVoiceInputDecibels(status.metering);
      const history = audioLevelsRef.current;
      if (level !== 0 || history.some((sample) => sample !== 0)) {
        const nextLevels = [...history.slice(1), level];
        audioLevelsRef.current = nextLevels;
        audioLevels.set(nextLevels);
      }

      const nextElapsedSeconds = Math.min(
        VOICE_RECORDING_LIMIT_SECONDS,
        Math.max(0, Math.floor(status.durationMillis / 1_000)),
      );
      if (nextElapsedSeconds !== elapsedSecondsRef.current) {
        elapsedSecondsRef.current = nextElapsedSeconds;
        setElapsedSeconds(nextElapsedSeconds);
      }
    };

    let intervalId: ReturnType<typeof setInterval> | undefined;
    const updateSampling = () => {
      clearInterval(intervalId);
      intervalId = undefined;
      if (AppState.currentState !== "active") return;
      sampleRecording();
      intervalId = setInterval(sampleRecording, VOICE_METERING_INTERVAL_MS);
    };
    updateSampling();
    const subscription = AppState.addEventListener("change", updateSampling);
    return () => {
      clearInterval(intervalId);
      subscription.remove();
    };
  }, [audioLevels, controller, recorder, state.phase, isFocused, ownsSession]);

  const start = useCallback(() => {
    const current = latestInputRef.current;
    if (current.disabled || !current.ownerKey) return;
    void session.start(current.ownerKey, current.selection).then((started) => {
      if (!started)
        Alert.alert(
          "Voice recording in progress",
          "Return to the original draft to finish or cancel its recording.",
        );
    });
  }, [session]);
  const stop = useCallback(
    () => (ownsSession ? controller.stop() : Promise.resolve()),
    [controller, ownsSession],
  );
  const cancel = useCallback(() => {
    if (ownsSession) controller.cancel();
  }, [controller, ownsSession]);

  return {
    // Store screenshots show the dictation button even on simulators, whose
    // on-device transcription is unavailable.
    isAvailable: getLocalVoiceTranscriber() !== null || getNativeShowcaseScene() !== null,
    state,
    audioLevels,
    elapsedSeconds,
    isBusy: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputFreezesEditor(state),
    blocksSubmission: voiceInputBlocksSubmission(state),
    start,
    stop,
    cancel,
  };
}
