import { create } from "zustand";

export interface WindowTitleContext {
  projectTitle: string | null;
  threadTitle: string | null;
}

/** Active project/thread context mirrored into document.title by the root layout. */
export const useWindowTitleContextStore = create<WindowTitleContext>()(() => ({
  projectTitle: null,
  threadTitle: null,
}));

export function setWindowTitleContext(context: WindowTitleContext): void {
  useWindowTitleContextStore.setState(context);
}

export function clearWindowTitleContext(): void {
  setWindowTitleContext({ projectTitle: null, threadTitle: null });
}
