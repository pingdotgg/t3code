import { MICROPHONE_PERMISSION_ERROR } from "@t3tools/client-runtime/voice-input";
import { CheckIcon, MicIcon, PauseIcon, PlayIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import workletUrl from "../../speech/pcmWorklet.ts?worker&url";
import { VoiceInputErrorPill } from "../chat/VoiceInputErrorPill";
import { VoiceInputPill, VoiceWaveform } from "../chat/VoiceInputPill";
import { MediaScrubber } from "../media/MediaTransport";
import { Button } from "../ui/button";
import { Text } from "../ui/text";

const LOOPBACK_SECONDS = 10;
const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

type Capture = {
  stream?: MediaStream;
  recorder?: MediaRecorder;
  context?: AudioContext;
  worklet?: AudioWorkletNode;
  timer?: ReturnType<typeof setTimeout>;
  elapsedTimer?: ReturnType<typeof setInterval>;
  startedAt?: number;
};

/**
 * Records a few seconds and plays them back in the browser. The audio never leaves this
 * device: no environment, transcriber, or provider is involved, so a silent result points
 * at the microphone rather than at transcription.
 */
export function MicrophoneTest({ microphoneId }: { microphoneId: string }) {
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "ready">("idle");
  const [recording, setRecording] = useState<{ url: string; duration: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const capture = useRef<Capture | null>(null);
  const recordingUrl = useRef<string | null>(null);

  const releaseCapture = useStableCallback(() => {
    const current = capture.current;
    if (!current) return;
    capture.current = null;
    clearTimeout(current.timer);
    clearInterval(current.elapsedTimer);
    current.worklet?.disconnect();
    current.worklet?.port.close();
    if (current.recorder && current.recorder.state !== "inactive") current.recorder.stop();
    current.stream?.getTracks().forEach((track) => track.stop());
    void current.context?.close().catch(() => undefined);
  });
  const discard = () => {
    if (recordingUrl.current) URL.revokeObjectURL(recordingUrl.current);
    recordingUrl.current = null;
    setRecording(null);
    setPhase("idle");
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the microphone and the recording's object URL on unmount
  useEffect(
    () => () => {
      releaseCapture();
      if (recordingUrl.current) URL.revokeObjectURL(recordingUrl.current);
    },
    [releaseCapture],
  );

  const start = async () => {
    releaseCapture();
    discard();
    setError(null);
    setLevel(0);
    setElapsed(0);
    setPhase("starting");
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined" ||
      typeof AudioWorkletNode === "undefined"
    ) {
      setError("Microphone testing is unavailable in this browser. Use HTTPS or the desktop app.");
      setPhase("idle");
      return;
    }
    const current: Capture = {};
    capture.current = current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: microphoneId ? { deviceId: { exact: microphoneId } } : true,
      });
      if (capture.current !== current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      current.stream = stream;
      const recorder = new MediaRecorder(stream);
      current.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.addEventListener("dataavailable", ({ data }) => {
        if (capture.current === current && data.size) chunks.push(data);
      });
      recorder.addEventListener("stop", () => {
        if (capture.current !== current) return;
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const duration =
          current.startedAt === undefined ? 0 : (performance.now() - current.startedAt) / 1_000;
        releaseCapture();
        setLevel(0);
        if (!blob.size) {
          setError("No audio was recorded. Try again.");
          setPhase("idle");
          return;
        }
        recordingUrl.current = URL.createObjectURL(blob);
        setRecording({ url: recordingUrl.current, duration });
        setPhase("ready");
      });
      const onRecordingError = () => {
        if (capture.current !== current) return;
        releaseCapture();
        setLevel(0);
        setError("Could not record microphone audio. Try again.");
        setPhase("idle");
      };
      recorder.addEventListener("error", onRecordingError);
      for (const track of stream.getAudioTracks()) {
        track.addEventListener(
          "ended",
          () => {
            if (capture.current !== current) return;
            setError("The microphone disconnected.");
            if (recorder.state !== "inactive") recorder.stop();
          },
          { once: true },
        );
      }
      const context = new AudioContext();
      current.context = context;
      await context.audioWorklet.addModule(workletUrl);
      if (capture.current !== current) return;
      const worklet = new AudioWorkletNode(context, "t3-pcm-capture", {
        channelCount: 1,
        processorOptions: { meterOnly: true },
      });
      current.worklet = worklet;
      worklet.port.onmessage = ({ data }: MessageEvent<number | "stopped">) => {
        if (capture.current === current && typeof data === "number") setLevel(data);
      };
      worklet.onprocessorerror = onRecordingError;
      context.createMediaStreamSource(stream).connect(worklet);
      worklet.connect(context.destination);
      await context.resume();
      if (capture.current !== current) return;
      const startedAt = performance.now();
      current.startedAt = startedAt;
      current.elapsedTimer = setInterval(() => {
        setElapsed(Math.min(LOOPBACK_SECONDS, Math.floor((performance.now() - startedAt) / 1_000)));
      }, 100);
      recorder.start();
      worklet.port.postMessage("start", []);
      setPhase("recording");
      current.timer = setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, LOOPBACK_SECONDS * 1_000);
    } catch (cause) {
      if (capture.current !== current) return;
      releaseCapture();
      setPhase("idle");
      setError(
        typeof cause === "object" &&
          cause !== null &&
          "name" in cause &&
          cause.name === "NotAllowedError"
          ? MICROPHONE_PERMISSION_ERROR
          : cause instanceof Error
            ? cause.message
            : "Could not access the microphone.",
      );
    }
  };
  const cancel = () => {
    releaseCapture();
    discard();
    setError(null);
  };

  if (error) {
    return (
      <VoiceInputErrorPill
        error={error}
        errorAction="retry"
        onRetry={() => void start()}
        onDismiss={cancel}
      />
    );
  }
  if (phase === "idle") {
    return (
      <Button size="sm" variant="secondary" onClick={() => void start()}>
        <MicIcon />
        Test microphone
      </Button>
    );
  }
  if (phase === "ready" && recording) {
    return (
      <MicrophonePlayback
        key={recording.url}
        src={recording.url}
        duration={recording.duration}
        onRetry={() => void start()}
        onDone={cancel}
      />
    );
  }
  return (
    <VoiceInputPill>
      <Button
        size="icon-sm-pill"
        variant="ghost"
        aria-label="Cancel microphone test"
        onClick={cancel}
      >
        <XIcon />
      </Button>
      {phase === "recording" ? (
        <>
          <VoiceWaveform level={level} />
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
          <Text variant="meta" tone="muted" numeric aria-label="Recording time">
            {formatTime(elapsed)} / {formatTime(LOOPBACK_SECONDS)}
          </Text>
          <meter
            aria-label="Microphone input level"
            min={0}
            max={1}
            value={level}
            className="sr-only"
          />
        </>
      ) : (
        <span className="flex min-w-0 flex-1">
          <Text variant="meta" tone="muted" truncate role="status">
            Opening microphone…
          </Text>
        </span>
      )}
      <Button
        size="icon-sm-pill"
        aria-label="Stop recording"
        disabled={phase !== "recording"}
        onClick={() => {
          const recorder = capture.current?.recorder;
          if (recorder && recorder.state !== "inactive") recorder.stop();
        }}
      >
        <CheckIcon />
      </Button>
    </VoiceInputPill>
  );
}

function MicrophonePlayback({
  src,
  duration,
  onRetry,
  onDone,
}: {
  src: string;
  duration: number;
  onRetry(): void;
  onDone(): void;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [failed, setFailed] = useState(false);

  const togglePlayback = async () => {
    const player = audio.current;
    if (!player) return;
    if (!player.paused) {
      player.pause();
      return;
    }
    setFailed(false);
    if (player.ended) player.currentTime = 0;
    try {
      await player.play();
    } catch {
      setFailed(true);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={() => setPosition(audio.current?.currentTime ?? 0)}
        onError={() => setFailed(true)}
      />
      <VoiceInputPill>
        <Button
          size="icon-sm-pill"
          variant="ghost"
          aria-label={playing ? "Pause recording" : "Play recording"}
          onClick={() => void togglePlayback()}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <MediaScrubber
          state={{
            paused: !playing,
            currentTime: Math.min(position, duration),
            duration,
            muted: false,
          }}
          label="Recording playback position"
          trackClassName="bg-muted"
          playedClassName="bg-primary"
          onSeek={(next) => {
            if (audio.current) audio.current.currentTime = next;
            setPosition(next);
          }}
        />
        <Text variant="meta" tone="muted" numeric>
          {formatTime(position)}
        </Text>
        <Button size="icon-sm-pill" variant="ghost" aria-label="Record again" onClick={onRetry}>
          <RotateCcwIcon />
        </Button>
        <Button size="icon-sm-pill" aria-label="Done" onClick={onDone}>
          <CheckIcon />
        </Button>
      </VoiceInputPill>
      {failed ? (
        <Text variant="meta" tone="destructive" render={<p role="alert" />}>
          Could not play this recording. Try recording again.
        </Text>
      ) : null}
    </div>
  );
}
