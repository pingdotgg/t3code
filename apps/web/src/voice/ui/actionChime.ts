/** A short local completion tone. Speech and network latency are not involved. */
export function createActionChime() {
  let context: AudioContext | undefined;
  const unlock = async () => {
    context ??= new AudioContext();
    await context.resume();
  };
  return {
    unlock,
    play() {
      if (!context || context.state !== "running") return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime;
      oscillator.frequency.setValueAtTime(880, start);
      oscillator.frequency.exponentialRampToValueAtTime(1174, start + 0.09);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.07, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.14);
      oscillator.connect(gain).connect(context.destination);
      oscillator.addEventListener(
        "ended",
        () => {
          oscillator.disconnect();
          gain.disconnect();
        },
        { once: true },
      );
      oscillator.start(start);
      oscillator.stop(start + 0.15);
    },
    close() {
      void context?.close().catch(() => undefined);
      context = undefined;
    },
  };
}
