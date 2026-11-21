import {
  acquireCanvasDocument,
  isCanvasDocumentActive,
  onCanvasEnvironmentDisposed,
  type CanvasDocumentController,
} from "./canvasDocumentStore";
import { CanvasEngine, type CanvasEngineOptions } from "./engine/CanvasEngine";

interface CachedEngine {
  controller: CanvasDocumentController;
  canvas: HTMLCanvasElement;
  engine: CanvasEngine;
}

// Keep at most one detached editor, for one minute. Its document subscription
// stays current, but interaction listeners and rendering stop while detached.
let idle: (CachedEngine & { releaseDocument: () => void; timer: number }) | null = null;

function evict() {
  const previous = idle;
  if (!previous) return;
  idle = null;
  window.clearTimeout(previous.timer);
  previous.releaseDocument();
  // GPU destruction must not run inside the next thread's React commit.
  window.setTimeout(() => previous.engine.destroy(), 0);
}

export function acquireCanvasEngine(
  controller: CanvasDocumentController,
  options: CanvasEngineOptions,
): CachedEngine {
  if (idle?.controller === controller) {
    const current = idle;
    idle = null;
    window.clearTimeout(current.timer);
    current.releaseDocument();
    return current;
  }
  evict();
  const canvas = document.createElement("canvas");
  canvas.className = "absolute inset-0 size-full";
  return { controller, canvas, engine: new CanvasEngine(canvas, options) };
}

/** A paused editor can reattach without compiling shaders or rebuilding its scene. */
export function hasCachedCanvasEngine(controller: CanvasDocumentController) {
  return idle?.controller === controller;
}

export function releaseCanvasEngine(current: CachedEngine) {
  current.engine.setSuspended(true);
  current.engine.setSelection([]);
  current.engine.setHover(null);
  current.canvas.remove();
  if (!isCanvasDocumentActive(current.controller)) {
    window.setTimeout(() => current.engine.destroy(), 0);
    return;
  }
  evict();
  const document = acquireCanvasDocument(
    current.controller.environmentId,
    current.controller.documentId,
  );
  idle = { ...current, releaseDocument: document.release, timer: window.setTimeout(evict, 60_000) };
}

const stopCleanup = onCanvasEnvironmentDisposed((environmentId) => {
  if (idle?.controller.environmentId === environmentId) evict();
});
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stopCleanup();
    evict();
  });
