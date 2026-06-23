/**
 * Play a short, pleasant two-note chime for agent-stop notifications using the
 * Web Audio API. Asset-free and cross-platform. Silently no-ops if Web Audio
 * is unavailable (e.g. tests / unsupported environments).
 */
export function playNotificationTone(): void {
  try {
    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now); // A5
    osc.frequency.setValueAtTime(1318.51, now + 0.13); // E6
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.46);
    osc.onended = () => {
      void ctx.close();
    };
  } catch (error) {
    // Audio is best-effort; never let it break the notification flow.
    console.warn("playNotificationTone failed", error);
  }
}
