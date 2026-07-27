export function captureDocumentFocus(): HTMLElement | null {
  const activeElement = document.activeElement;
  return activeElement instanceof HTMLElement && activeElement.isConnected ? activeElement : null;
}

export function restoreDocumentFocus(element: HTMLElement | null): void {
  if (!element?.isConnected) return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    // Focus restoration is best-effort when the element becomes unavailable.
  }
}

export async function runPreservingDocumentFocus<T>(operation: () => Promise<T>): Promise<T> {
  const previouslyFocused = captureDocumentFocus();
  try {
    return await operation();
  } finally {
    restoreDocumentFocus(previouslyFocused);
  }
}
