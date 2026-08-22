/**
 * Run a state-changing mouse action after OpenTUI has finished dispatching the
 * current event. Replacing the render tree from inside a bubbling mouse event
 * can otherwise leave the native hit-test path holding destroyed renderables.
 */
export function deferMouseAction(action: () => void): () => void {
  let queued = false;

  return () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      action();
    });
  };
}
