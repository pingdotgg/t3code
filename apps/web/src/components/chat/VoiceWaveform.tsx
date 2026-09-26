import { useEffect, useRef, useState } from "react";

// Keep drawing and history speed separate: the envelope reacts promptly while
// the history moves at 47px/s instead of shifting 140px/s with every frame.
const HISTORY_INTERVAL_MS = 150;
/** A smoothed microphone envelope, drawn at 20 Hz without rerendering the composer. */
export function VoiceWaveform({ stream }: { readonly stream: MediaStream | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stream) return;
    let audio: AudioContext;
    try {
      audio = new AudioContext();
    } catch {
      setUnavailable(true);
      return;
    }
    const source = audio.createMediaStreamSource(stream);
    const analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const levels = new Float32Array(180);
    const context = canvas.getContext("2d");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let previous = 0;
    let historyTime = performance.now();
    let envelope = 0;
    let peak = 0;
    let width = 0;
    const height = 32;
    let colour = getComputedStyle(canvas).color;
    const resize = () => {
      width = canvas.clientWidth;
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * scale);
      canvas.height = height * scale;
      context?.setTransform(scale, 0, 0, scale, 0, 0);
      colour = getComputedStyle(canvas).color;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    const draw = (time: number) => {
      if (document.hidden) return;
      frame = requestAnimationFrame(draw);
      if (time - previous < (reducedMotion.matches ? 250 : 50)) return;
      previous = time;
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      const rms = Math.sqrt(energy / samples.length);
      const level = Math.min(1, Math.pow(Math.max(0, rms - 0.005) * 6, 0.65));
      envelope += (level - envelope) * (level > envelope ? 0.65 : 0.2);
      peak = Math.max(peak, envelope);
      if (time - historyTime >= HISTORY_INTERVAL_MS) {
        levels.copyWithin(0, 1);
        levels[levels.length - 1] = peak;
        peak = 0;
        historyTime = time;
      }
      const scroll = reducedMotion.matches ? 0 : ((time - historyTime) / HISTORY_INTERVAL_MS) * 7;
      if (!context) return;
      context.clearRect(0, 0, width, height);
      context.fillStyle = colour;
      const count = Math.min(levels.length, Math.floor(width / 7));
      for (let index = 0; index < count; index++) {
        // Reduced motion keeps the signal in place instead of scrolling history.
        const amplitude = reducedMotion.matches ? envelope : levels[levels.length - count + index]!;
        const barHeight = 3 + amplitude * 25;
        context.globalAlpha = 0.3 + amplitude * 0.6;
        context.beginPath();
        context.roundRect(
          width - (count - index) * 7 - scroll,
          (height - barHeight) / 2,
          3,
          barHeight,
          1.5,
        );
        context.fill();
      }
    };
    const visibilityChanged = () => {
      cancelAnimationFrame(frame);
      if (!document.hidden) {
        historyTime = performance.now();
        frame = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    frame = requestAnimationFrame(draw);
    let disposed = false;
    void audio.resume().catch(() => {
      if (!disposed) setUnavailable(true);
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibilityChanged);
      source.disconnect();
      analyser.disconnect();
      void audio.close().catch(() => {});
    };
  }, [stream]);

  return unavailable ? (
    <span className="min-w-0 flex-1 text-xs text-muted-foreground">
      Microphone level unavailable
    </span>
  ) : (
    <canvas
      ref={canvasRef}
      className="h-8 min-w-0 flex-1 text-foreground"
      role="img"
      aria-label="Live microphone waveform"
    />
  );
}
