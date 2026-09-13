import type { ScopedProjectRef, ScopedTaskRef } from "@t3tools/contracts";
import { Dialog } from "@base-ui/react/dialog";
import { create } from "zustand";

type TaskDialogRequest =
  | { kind: "create"; projectRef: ScopedProjectRef | null }
  | { kind: "rename" | "delete"; taskRef: ScopedTaskRef };

export const useTaskDialogStore = create<{
  request: TaskDialogRequest | null;
  open: (request: TaskDialogRequest) => void;
  close: () => void;
}>()((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

export function requestNewTask(projectRef: ScopedProjectRef | null = null) {
  useTaskDialogStore.getState().open({ kind: "create", projectRef });
}
export function requestRenameTask(taskRef: ScopedTaskRef) {
  useTaskDialogStore.getState().open({ kind: "rename", taskRef });
}
export function requestDeleteTask(taskRef: ScopedTaskRef) {
  useTaskDialogStore.getState().open({ kind: "delete", taskRef });
}
export const addThreadsToTaskDialog = Dialog.createHandle<ScopedTaskRef>();

export function requestAddThreadsToTask(taskRef: ScopedTaskRef) {
  addThreadsToTaskDialog.openWithPayload(taskRef);
}
