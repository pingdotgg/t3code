import type { Editor } from "@pierre/diffs/editor";

/** Carry code focus across a view remount, but never reclaim it from another control. */
export function createFileEditorFocusRestorer() {
  let focusedContainer: HTMLElement | null = null;
  return {
    onUnmount(container: HTMLElement) {
      focusedContainer = container.shadowRoot?.activeElement?.hasAttribute("data-content")
        ? container
        : null;
    },
    // onPostRender("mount") precedes editor attachment. Pierre's onAttach runs after
    // the editable DOM and persisted selection are ready, including deferred renders.
    onAttach(editor: Pick<Editor<unknown>, "getFile" | "focus">) {
      if (focusedContainer === null || editor.getFile() === undefined) return;
      const previous = focusedContainer;
      focusedContainer = null;
      const document = previous.ownerDocument;
      const active = document.activeElement;
      if (active !== document.body && active !== previous) return;
      editor.focus({ preventScroll: true });
    },
  };
}
