interface FileEditorDismissalOptions {
  root: HTMLElement;
  editor: {
    setSelections: (selections: []) => void;
  };
  isBlocked: () => boolean;
  onDismiss: () => void;
}

function dismissFileEditorInteraction({
  root,
  editor,
  onDismiss,
}: Pick<FileEditorDismissalOptions, "root" | "editor" | "onDismiss">): void {
  onDismiss();
  editor.setSelections([]);

  const file = root.querySelector<HTMLElement>("diffs-container");
  const activeElement = file?.shadowRoot?.activeElement;
  if (activeElement instanceof HTMLElement) {
    activeElement.blur();
  }
}

function isFileEditorFocused(root: HTMLElement): boolean {
  const file = root.querySelector<HTMLElement>("diffs-container");
  return file?.shadowRoot?.activeElement?.hasAttribute("data-content") === true;
}

export function installFileEditorDismissal({
  root,
  editor,
  isBlocked,
  onDismiss,
}: FileEditorDismissalOptions): () => void {
  const handlePointerDown = (event: PointerEvent) => {
    if (isBlocked() || event.composedPath().includes(root)) return;
    dismissFileEditorInteraction({ root, editor, onDismiss });
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || isBlocked() || !isFileEditorFocused(root)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dismissFileEditorInteraction({ root, editor, onDismiss });
  };

  document.addEventListener("pointerdown", handlePointerDown, true);
  document.addEventListener("keydown", handleKeyDown, true);
  return () => {
    document.removeEventListener("pointerdown", handlePointerDown, true);
    document.removeEventListener("keydown", handleKeyDown, true);
  };
}
