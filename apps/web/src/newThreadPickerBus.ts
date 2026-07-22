// Tiny event bus connecting the global chat.new shortcut (handled in the
// _chat route layout) to SidebarV2's project picker dialog. The route layer
// can't render the picker itself — it lives with the sidebar — and the
// sidebar can't own the window keydown handler without racing the layout's.
const NEW_THREAD_PICKER_EVENT = "t3code:open-new-thread-picker";

export function openNewThreadPicker(): void {
  window.dispatchEvent(new CustomEvent(NEW_THREAD_PICKER_EVENT));
}

export function onOpenNewThreadPicker(listener: () => void): () => void {
  window.addEventListener(NEW_THREAD_PICKER_EVENT, listener);
  return () => window.removeEventListener(NEW_THREAD_PICKER_EVENT, listener);
}
