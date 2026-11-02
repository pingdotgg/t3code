export function idleAfterPaint(callback: () => void): () => void {
  if (!("requestIdleCallback" in window)) return () => {};

  let frame: number;
  let idle: number | undefined;
  const schedule = () => {
    idle = window.requestIdleCallback(
      (deadline) => {
        if (deadline.timeRemaining() < 8) {
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
  };
}
