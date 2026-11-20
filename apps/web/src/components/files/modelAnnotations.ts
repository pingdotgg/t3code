import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  ModelCameraView,
  ModelCapture,
  ModelNote,
} from "@t3tools/client-runtime/model-preview/annotations";
import { create } from "zustand";

import { rightPanelHostRef, useRightPanelStore } from "~/rightPanelStore";

/** Opens a file in the thread's right panel, at a saved camera when it is a model. */
export function openFileAtModelView(
  threadRef: ScopedThreadRef,
  path: string,
  view: ModelCameraView | null,
  line?: number,
) {
  if (view) {
    useModelPreviewStore
      .getState()
      .requestView(modelViewRequestKey(rightPanelHostRef(threadRef), path), view);
  }
  useRightPanelStore.getState().openFile(threadRef, path, line);
}

interface ModelPreviewMemory {
  readonly fingerprint: string;
  readonly notes: ReadonlyArray<ModelNote>;
  readonly view: ModelCameraView;
  readonly wireframe: boolean;
  /** The annotated view captured before the geometry changed under stale notes. */
  readonly capture: { readonly screenshot: ModelCapture; readonly view: ModelCameraView } | null;
}

interface ModelPreviewStore {
  /** Notes and camera per open model, so a reload of a changed file keeps them. */
  readonly memory: Readonly<Record<string, ModelPreviewMemory>>;
  /** Cameras requested by clicked links, applied by the viewer showing that file. */
  readonly viewRequests: Readonly<Record<string, ModelCameraView>>;
  readonly remember: (key: string, memory: ModelPreviewMemory) => void;
  readonly requestView: (key: string, view: ModelCameraView) => void;
  readonly consumeView: (key: string) => void;
}

// Bounds what a long session keeps; the oldest model drops out first.
const MAX_REMEMBERED_MODELS = 20;

export const useModelPreviewStore = create<ModelPreviewStore>()((set) => ({
  memory: {},
  viewRequests: {},
  remember: (key, memory) =>
    set((state) => {
      const { [key]: _previous, ...rest } = state.memory;
      const keys = Object.keys(rest);
      const kept =
        keys.length < MAX_REMEMBERED_MODELS
          ? rest
          : Object.fromEntries(keys.slice(1).map((entry) => [entry, rest[entry]!]));
      return { memory: { ...kept, [key]: memory } };
    }),
  requestView: (key, view) =>
    set((state) => ({
      viewRequests: { ...state.viewRequests, [key]: view },
    })),
  consumeView: (key) =>
    set((state) => {
      const { [key]: _consumed, ...viewRequests } = state.viewRequests;
      return { viewRequests };
    }),
}));

/** Routes a camera to the file surface in the panel that opened it. */
export const modelViewRequestKey = (threadRef: ScopedThreadRef, path: string) =>
  JSON.stringify([scopedThreadKey(threadRef), path]);
