let audioContextInstance: AudioContext | null = null;

export function __resetAudioContextForTests(): void {
  audioContextInstance = null;
}

function getAudioContext(): AudioContext | null {
  const AudioContextClass =
    (typeof window !== "undefined"
      ? window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined) ??
    (typeof globalThis !== "undefined"
      ? (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext
      : undefined);

  if (!AudioContextClass) return null;
  if (!audioContextInstance || audioContextInstance.state === "closed") {
    try {
      audioContextInstance = new AudioContextClass();
    } catch {
      return null;
    }
  }
  return audioContextInstance;
}

export function playTurnCompletionSound(): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    if (ctx.state === "suspended") {
      void ctx.resume();
    }

    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.12, now);
    masterGain.connect(ctx.destination);

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(587.33, now);
    gain1.gain.setValueAtTime(0, now);
    gain1.gain.linearRampToValueAtTime(1, now + 0.01);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    osc1.connect(gain1);
    gain1.connect(masterGain);
    osc1.start(now);
    osc1.stop(now + 0.09);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(880, now + 0.08);
    gain2.gain.setValueAtTime(0, now + 0.08);
    gain2.gain.linearRampToValueAtTime(1, now + 0.09);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    osc2.connect(gain2);
    gain2.connect(masterGain);
    osc2.start(now + 0.08);
    osc2.stop(now + 0.22);
  } catch {}
}
