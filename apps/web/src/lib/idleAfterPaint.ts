export function idleAfterPaint(callback: () => void): () => void {
  let frame: number;
  let idle: number | undefined;
  let fallback: number | undefined;
  const schedule = () => {
    if (!("requestIdleCallback" in globalThis)) {
      fallback = window.setTimeout(callback, 0);
      return;
    }
    idle = window.requestIdleCallback(
      (deadline) => {
        if (!deadline.didTimeout && deadline.timeRemaining() < 8) {
          schedule();
          return;
        }
        callback();
      },
      { timeout: 2_000 },
    );
  };
  frame = window.requestAnimationFrame(() => {
    frame = window.requestAnimationFrame(schedule);
  });
  return () => {
    window.cancelAnimationFrame(frame);
    if (idle !== undefined) window.cancelIdleCallback(idle);
    if (fallback !== undefined) window.clearTimeout(fallback);
  };
}
