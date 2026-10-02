import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { VoiceInputController, type VoiceInputState } from "@t3tools/client-runtime/voice-input";
import type { SpeechStreamText, SpeechTranscriptionOptions } from "@t3tools/contracts";
import { MicIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { createBrowserVoiceInputPlatform } from "../../speech/browserVoiceInput";
import { ComposerSpeechRecordingPill } from "../chat/ComposerSpeechButton";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function TranscriptionTest({
  prepared,
  microphoneId,
  disabled,
  modelName,
  options,
}: {
  prepared: PreparedConnection | null;
  microphoneId: string;
  disabled: boolean;
  modelName: string;
  options: SpeechTranscriptionOptions;
}) {
  const [state, setState] = useState<VoiceInputState<true>>({
    phase: "idle",
    error: null,
    errorAction: null,
  });
  const [level, setLevel] = useState(0);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [preview, setPreview] = useState<SpeechStreamText | null>(null);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);
  const controller = useRef<VoiceInputController<true> | null>(null);
  const [connection, setConnection] = useState(prepared);
  if (connection !== prepared) {
    setConnection(prepared);
    setState({ phase: "idle", error: null, errorAction: null });
    setTranscript(null);
    setPreview(null);
  }

  useEffect(() => {
    if (!prepared) return;
    let disposed = false;
    const platform = createBrowserVoiceInputPlatform({
      prepared,
      getTranscriptionOptions: () => optionsRef.current,
      getMicrophoneId: () => microphoneId,
      onLevel: (value) => {
        if (!disposed) setLevel(value);
      },
      onDurationLimit: () => void instance.stop(),
      onText: (text) => {
        if (!disposed) setPreview(text);
      },
      onError: (message) => {
        if (!disposed) void instance.interruptRecording(message);
      },
    });
    const instance = new VoiceInputController<true>({
      recorder: {
        get uri() {
          return platform.recorder.uri;
        },
        prepareToRecordAsync: () => platform.recorder.prepareToRecordAsync(),
        record: () => platform.recorder.record({ forDuration: 10 }),
        stop: () => platform.recorder.stop(),
      },
      getTranscriber: () => platform.transcriber,
      requestPermission: async () => ({ granted: true, canAskAgain: true }),
      configureRecording: async () => {},
      releaseRecording: async () => platform.cancelRecording(),
      deleteRecording: platform.deleteRecording,
      readDraft: () => ({
        ownerKey: "transcription-test",
        text: "",
        selection: { start: 0, end: 0 },
        revision: 0,
      }),
      commitDraft: (text) => {
        if (!disposed) setTranscript(text);
      },
      onStateChange: (value) => {
        if (!disposed) {
          setState(value);
          if (value.phase !== "recording" && value.phase !== "transcribing") setPreview(null);
        }
      },
    });
    controller.current = instance;
    return () => {
      disposed = true;
      controller.current = null;
      instance.dispose();
    };
  }, [prepared, microphoneId]);

  const busy = state.phase !== "idle" && state.phase !== "error";
  return (
    <SettingsRow
      {...searchableSetting("transcription-test")}
      title="Active model"
      description="Models run on the selected environment. Test without post-processing. Recordings are deleted after transcription."
      control={
        <div className="flex flex-wrap items-center gap-3">
          {busy ? (
            <ComposerSpeechRecordingPill
              state={state}
              progress={null}
              level={level}
              recordingLimitSeconds={10}
              onStop={() => void controller.current?.stop()}
              onCancel={() => controller.current?.cancel()}
              onSkipPostProcessing={() => {}}
            />
          ) : (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || !prepared}
                onClick={() => {
                  setTranscript(null);
                  setPreview(null);
                  void controller.current?.start();
                }}
              >
                <MicIcon />
                {transcript !== null ? "Try again" : "Test model"}
              </Button>
              {transcript !== null ? (
                <Button size="sm" onClick={() => setTranscript(null)}>
                  Done
                </Button>
              ) : null}
            </div>
          )}
          <span className="text-sm text-muted-foreground">{modelName}</span>
        </div>
      }
    >
      {transcript !== null || preview !== null ? (
        <div className="pt-3 pb-2">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Test transcription</p>
          <p
            aria-label="Test transcription"
            className="select-text whitespace-pre-wrap break-words text-sm leading-relaxed"
          >
            {transcript !== null ? (
              transcript || "No speech recognized. Try again."
            ) : (
              <>
                <span>{preview?.committed}</span>
                <span className="text-muted-foreground">{preview?.tentative}</span>
              </>
            )}
          </p>
        </div>
      ) : null}
      {state.error ? (
        <p role="alert" className="pt-3 pb-2 text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
    </SettingsRow>
  );
}
