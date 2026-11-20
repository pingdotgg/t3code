import { MAX_MODEL_BYTES, type ModelNote } from "@t3tools/client-runtime/model-preview/annotations";
import { isModelPreviewError } from "@t3tools/client-runtime/model-preview/error";
import { isZipError } from "@t3tools/client-runtime/zip/error";
import { ModelScene } from "@t3tools/client-runtime/model-preview/scene";

import {
  createModelByteSink,
  type ModelViewerColors,
  type ModelViewerCommand,
  type ModelViewerEvent,
} from "./model-viewer-protocol";

declare global {
  interface Window {
    ReactNativeWebView: { postMessage: (message: string) => void };
  }
}

// A tap moves less than this and lifts within TAP_MS; a second tap within DOUBLE_TAP_MS fits.
const TAP_SLOP_PX = 8;
const TAP_MS = 400;
const DOUBLE_TAP_MS = 300;

const post = (event: ModelViewerEvent) =>
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- the React Native bridge takes only the message
  window.ReactNativeWebView.postMessage(JSON.stringify(event));

/**
 * The native model viewer's page: it parses and draws with the shared `ModelScene`, draws
 * numbered pins over it, and reports taps, camera changes and captures to native.
 */
export function start() {
  const viewport = document.createElement("div");
  viewport.id = "viewport";
  const pinLayer = document.createElement("div");
  pinLayer.id = "pins";
  document.body.append(viewport, pinLayer);

  let scene: ModelScene | null = null;
  let sceneId: number | null = null;
  let requestedView: Extract<ModelViewerCommand, { type: "view" }>["view"] | null = null;
  let loading: { id: number; controller: AbortController } | null = null;
  let sink: { id: number; sink: ReturnType<typeof createModelByteSink> } | null = null;
  let wireframe = false;
  let annotating = false;
  let notes: ReadonlyArray<ModelNote> = [];
  let activeId: string | null = null;
  let draft: Extract<ModelViewerCommand, { type: "notes" }>["draft"] = null;
  let colors: ModelViewerColors | null = null;
  const pins = new Map<string, HTMLButtonElement>();

  const pinStyle = (element: HTMLElement, active: boolean) => {
    const dot = element.firstElementChild as HTMLElement;
    if (!colors) return;
    dot.style.background = active ? colors.pinText : colors.pin;
    dot.style.color = active ? colors.pin : colors.pinText;
    dot.style.borderColor = active ? colors.pin : colors.ring;
  };

  const placePins = () => {
    if (!scene) return;
    const shown = notes.filter((note) => !note.stale);
    if (draft) {
      shown.push({
        ...draft,
        id: "draft",
        text: "",
        stale: false,
      });
    }
    const placed = scene.project(shown);
    for (const [id, element] of pins) {
      if (!shown.some((note) => note.id === id)) {
        element.remove();
        pins.delete(id);
      }
    }
    shown.forEach((note, index) => {
      let element = pins.get(note.id);
      if (!element) {
        element = document.createElement("button");
        element.className = "pin";
        element.append(document.createElement("span"));
        if (note.id !== "draft") {
          const id = note.id;
          element.addEventListener("click", () => post({ type: "pin", id }));
        }
        pinLayer.append(element);
        pins.set(note.id, element);
      }
      const dot = element.firstElementChild as HTMLElement;
      dot.textContent = String(note.number);
      pinStyle(element, note.id === activeId || note.id === "draft");
      const pin = placed[index];
      if (!pin) return;
      element.style.transform = `translate(${pin.x}px, ${pin.y}px) translate(-50%, -50%)`;
      element.style.opacity = pin.behind ? "0.45" : "1";
    });
  };

  // OrbitControls moves the camera on pointer moves, so comparing the camera when the gesture
  // starts and ends tells native once whether it moved.
  const pointers = new Set<number>();
  let gestureStart: string | null = null;
  let tap: { x: number; y: number; at: number } | null = null;
  let lastTapAt = 0;
  viewport.addEventListener(
    "pointerdown",
    (event) => {
      pointers.add(event.pointerId);
      if (pointers.size === 1) gestureStart = scene ? JSON.stringify(scene.view) : null;
      tap =
        pointers.size === 1 ? { x: event.clientX, y: event.clientY, at: event.timeStamp } : null;
    },
    { capture: true },
  );
  const endPointer = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return;
    const started = tap;
    tap = null;
    if (pointers.size > 0 || !scene) return;
    const view = scene.view;
    if (gestureStart !== null && gestureStart !== JSON.stringify(view)) {
      gestureStart = null;
      post({ type: "view", view, moved: true });
      return;
    }
    if (
      event.type !== "pointerup" ||
      !started ||
      event.timeStamp - started.at > TAP_MS ||
      Math.hypot(event.clientX - started.x, event.clientY - started.y) > TAP_SLOP_PX
    ) {
      return;
    }
    if (annotating) {
      const hit = scene.pick(event.clientX, event.clientY);
      if (hit) post({ type: "pick", hit });
      return;
    }
    if (event.timeStamp - lastTapAt < DOUBLE_TAP_MS) {
      lastTapAt = 0;
      scene.setPreset("fit");
      post({ type: "view", view: scene.view, moved: true });
      return;
    }
    lastTapAt = event.timeStamp;
  };
  viewport.addEventListener("pointerup", endPointer, { capture: true });
  viewport.addEventListener("pointercancel", endPointer, { capture: true });

  const disposeScene = () => {
    scene?.dispose();
    scene = null;
    sceneId = null;
    for (const element of pins.values()) element.remove();
    pins.clear();
  };

  const load = async (command: Extract<ModelViewerCommand, { type: "end" }>) => {
    if (sink?.id !== command.id) return;
    const bytes = sink.sink.bytes();
    sink = null;
    const controller = new AbortController();
    loading = { id: command.id, controller };
    try {
      // The old scene stays up until the new one is ready, so a reload keeps its frame.
      const loaded = await ModelScene.load({
        container: viewport,
        bytes,
        format: command.format,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        loaded.dispose();
        return;
      }
      const view = requestedView ?? scene?.view ?? command.view;
      requestedView = null;
      if (scene?.summary.fingerprint !== loaded.summary.fingerprint) {
        notes = [];
        draft = null;
      }
      disposeScene();
      scene = loaded;
      sceneId = command.id;
      loaded.setWireframe(wireframe);
      if (view) loaded.setView(view);
      loaded.setFrameListener(placePins);
      post({ type: "loaded", id: command.id, summary: loaded.summary, view: loaded.view });
    } catch (cause) {
      if (controller.signal.aborted) return;
      post({
        type: "failed",
        id: command.id,
        code: isModelPreviewError(cause) || isZipError(cause) ? cause.code : "model-invalid",
      });
    } finally {
      if (loading?.controller === controller) loading = null;
    }
  };

  const command = (input: ModelViewerCommand) => {
    switch (input.type) {
      case "theme":
        colors = input.colors;
        document.body.style.background = input.colors.background;
        for (const [id, element] of pins) {
          pinStyle(element, id === activeId || id === "draft");
        }
        return;
      case "begin":
        loading?.controller.abort();
        loading = null;
        sink = { id: input.id, sink: createModelByteSink(MAX_MODEL_BYTES) };
        return;
      case "chunk":
        if (sink?.id !== input.id) {
          post({ type: "failed", id: input.id, code: "model-invalid" });
          return;
        }
        try {
          sink.sink.push(input.data);
        } catch {
          sink = null;
          post({ type: "failed", id: input.id, code: "model-invalid" });
          return;
        }
        post({ type: "ack", id: input.id });
        return;
      case "end":
        void load(input);
        return;
      case "cancel":
        if (sink?.id === input.id) sink = null;
        if (loading?.id === input.id) loading.controller.abort();
        return;
      case "preset":
        if (!scene) return;
        scene.setPreset(input.preset);
        post({ type: "view", view: scene.view, moved: false });
        return;
      case "view":
        if (!scene) {
          requestedView = input.view;
          return;
        }
        scene.setView(input.view);
        post({ type: "view", view: scene.view, moved: false });
        return;
      case "wireframe":
        wireframe = input.on;
        scene?.setWireframe(input.on);
        return;
      case "annotate":
        annotating = input.on;
        return;
      case "notes":
        notes = input.notes;
        activeId = input.activeId;
        draft = input.draft;
        placePins();
        scene?.requestRender();
        return;
      case "capture": {
        let result = null;
        try {
          if (scene && sceneId === input.id) {
            result = { screenshot: scene.capture(input.notes), view: scene.view };
          }
        } catch {}
        post({ type: "captured", id: input.id, requestId: input.requestId, result });
        return;
      }
    }
  };

  // The page leaves with the native view; free the GPU context instead of waiting for collection.
  window.addEventListener("pagehide", () => {
    loading?.controller.abort();
    disposeScene();
  });
  post({ type: "ready" });
  return { command };
}
