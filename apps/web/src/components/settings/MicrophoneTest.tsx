import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MicIcon, CheckIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { VoiceInputPill, VoiceWaveform } from "../chat/VoiceInputPill";
import { MicrophoneTestPlayback } from "./MicrophoneTestPlayback";

export function MicrophoneTest({
  microphoneId,
  microphoneControl,
  description,
}: {
  microphoneId: string;
  microphoneControl?: ReactNode;
  description?: string;
}) {
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "ready">("idle");
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const session = useRef<{
    stream?: MediaStream;
    recorder?: MediaRecorder;
    context?: AudioContext;
    timer?: ReturnType<typeof setTimeout>;
    meter?: ReturnType<typeof setInterval>;
    startedAt?: number;
  } | null>(null);
  const url = useRef<string | null>(null);

  const releaseCapture = useCallback(() => {
    const current = session.current;
    if (!current) return;
    session.current = null;
    clearTimeout(current.timer);
    clearInterval(current.meter);
    if (current.recorder && current.recorder.state !== "inactive") current.recorder.stop();
    current.stream?.getTracks().forEach((track) => track.stop());
    void current.context?.close().catch(() => {});
  }, []);

  function discard() {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
    setRecordingUrl(null);
    setPhase("idle");
  }

  useEffect(() => {
    return () => {
      releaseCapture();
      if (url.current) URL.revokeObjectURL(url.current);
    };
  }, [releaseCapture]);

  async function start() {
    discard();
    setError(null);
    setLevel(0);
    setElapsed(0);
    setPhase("starting");
    const current: NonNullable<typeof session.current> = {};
    session.current = current;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error(
          "Microphone testing is unavailable in this browser. Use HTTPS or the desktop app.",
        );
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: microphoneId ? { deviceId: { exact: microphoneId } } : true,
      });
      if (session.current !== current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      current.stream = stream;
      const recorder = new MediaRecorder(stream);
      current.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.addEventListener("dataavailable", ({ data }) => {
        if (session.current === current && data.size) chunks.push(data);
      });
      recorder.addEventListener("stop", () => {
        if (session.current !== current) return;
        const blob = new Blob(chunks, { type: recorder.mimeType });
        setDuration(
          current.startedAt === undefined ? 0 : (performance.now() - current.startedAt) / 1_000,
        );
        releaseCapture();
        setLevel(0);
        if (!blob.size) {
          setError("No audio was recorded. Try again.");
          setPhase("idle");
          return;
        }
        url.current = URL.createObjectURL(blob);
        setRecordingUrl(url.current);
        setPhase("ready");
      });
      recorder.addEventListener("error", () => {
        if (session.current !== current) return;
        releaseCapture();
        setLevel(0);
        setError("Could not record microphone audio. Try again.");
        setPhase("idle");
      });
      for (const track of stream.getAudioTracks()) {
        track.addEventListener(
          "ended",
          () => {
            if (session.current !== current) return;
            setError("The microphone disconnected.");
            if (recorder.state !== "inactive") recorder.stop();
          },
          { once: true },
        );
      }
      const context = new AudioContext();
      current.context = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      await context.resume();
      if (session.current !== current) return;
      const samples = new Float32Array(analyser.fftSize);
      const startedAt = performance.now();
      current.startedAt = startedAt;
      current.meter = setInterval(() => {
        setElapsed(Math.min(10, Math.floor((performance.now() - startedAt) / 1_000)));
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(
          samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
        );
        setLevel(Math.min(100, Math.round(rms * 500)));
      }, 100);
      recorder.start();
      setPhase("recording");
      current.timer = setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, 10_000);
    } catch (cause) {
      if (session.current !== current) return;
      releaseCapture();
      setPhase("idle");
      setError(cause instanceof Error ? cause.message : "Could not access the microphone.");
    }
  }

  function cancel() {
    releaseCapture();
    discard();
    setError(null);
  }

  return (
    <SettingsRow
      {...searchableSetting("microphone")}
      description={description}
      control={
        <div className="flex w-full flex-col gap-2 sm:w-auto">
          <div className="flex min-h-10 min-w-0 items-center gap-2">
            {phase === "idle" ? (
              <Button
                size="sm"
                variant="outline"
                aria-label="Test mic"
                onClick={() => void start()}
              >
                <MicIcon />
                Test mic
              </Button>
            ) : phase === "ready" && recordingUrl ? (
              <MicrophoneTestPlayback
                key={recordingUrl}
                src={recordingUrl}
                duration={duration}
                onRetry={() => void start()}
                onDone={cancel}
              />
            ) : (
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
                    <VoiceWaveform level={level / 100} />
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
                    <span
                      className="shrink-0 text-xs tabular-nums text-muted-foreground"
                      aria-label="Recording time"
                    >
                      0:{String(elapsed).padStart(2, "0")} / 0:10
                    </span>
                    <meter
                      aria-label="Microphone input level"
                      min={0}
                      max={100}
                      value={level}
                      className="sr-only"
                    />
                  </>
                ) : (
                  <span
                    role="status"
                    className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                  >
                    Opening mic…
                  </span>
                )}
                <Button
                  size="icon-sm-pill"
                  aria-label="Stop recording"
                  disabled={phase !== "recording"}
                  onClick={() => {
                    const recorder = session.current?.recorder;
                    if (recorder && recorder.state !== "inactive") recorder.stop();
                  }}
                >
                  <CheckIcon />
                </Button>
              </VoiceInputPill>
            )}
            {microphoneControl}
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      }
    />
  );
}
