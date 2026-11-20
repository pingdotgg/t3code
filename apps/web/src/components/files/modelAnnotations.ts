import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  rememberModelPreview,
  type ModelCameraView,
  type ModelPreviewMemory,
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

interface ModelPreviewStore {
  /** Notes and camera per open model, so a reload of a changed file keeps them. */
  readonly memory: Readonly<Record<string, ModelPreviewMemory>>;
  /** Cameras requested by clicked links, applied by the viewer showing that file. */
  readonly viewRequests: Readonly<Record<string, ModelCameraView>>;
  readonly remember: (key: string, memory: ModelPreviewMemory) => void;
  readonly requestView: (key: string, view: ModelCameraView) => void;
  readonly consumeView: (key: string) => void;
}

export const useModelPreviewStore = create<ModelPreviewStore>()((set) => ({
  memory: {},
  viewRequests: {},
  remember: (key, memory) =>
    set((state) => ({ memory: rememberModelPreview(state.memory, key, memory) })),
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
