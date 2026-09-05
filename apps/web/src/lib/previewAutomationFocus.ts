let latestOperationId = 0;

const getMeaningfulActiveElement = (): HTMLElement | null => {
  if (typeof document === "undefined" || typeof HTMLElement === "undefined") return null;

  const activeElement = document.activeElement;
  if (
    !(activeElement instanceof HTMLElement) ||
    !activeElement.isConnected ||
    activeElement === document.body ||
    activeElement === document.documentElement
  ) {
    return null;
  }
  return activeElement;
};

const isDocumentFocused = (): boolean => {
  if (typeof document === "undefined") return false;
  return typeof document.hasFocus !== "function" || document.hasFocus();
};

/**
 * Keeps preview automation from changing focus in the shared renderer.
 */
export async function withPreviewAutomationFocus<T>(operation: () => Promise<T>): Promise<T> {
  const operationId = ++latestOperationId;
  const previouslyFocused = getMeaningfulActiveElement();
  const wasDocumentFocused = isDocumentFocused();
  let userFocusObserved = false;
  let pendingUserFocus = false;
  let pendingVersion = 0;
  let nativeFocusElement: HTMLElement | null = null;
  let windowBlurred = false;
  let windowRefocused = false;

  const markPendingUserFocus = (event: Event): void => {
    if (!event.isTrusted) return;
    pendingUserFocus = true;
    const version = ++pendingVersion;
    queueMicrotask(() => {
      if (pendingVersion === version) pendingUserFocus = false;
    });
  };
  const onFocusIn = (event: Event): void => {
    const nativeFocusTransfer = windowBlurred && windowRefocused;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (nativeFocusTransfer) nativeFocusElement = target;
    if (event.isTrusted && (pendingUserFocus || (!nativeFocusTransfer && target?.isConnected))) {
      userFocusObserved = true;
    }
    pendingUserFocus = false;
    pendingVersion += 1;
    windowBlurred = false;
    windowRefocused = false;
  };
  const onWindowBlur = (): void => {
    windowBlurred = true;
    windowRefocused = false;
  };
  const onWindowFocus = (): void => {
    if (windowBlurred) windowRefocused = true;
  };

  if (typeof document !== "undefined") {
    document.addEventListener("pointerdown", markPendingUserFocus, true);
    document.addEventListener("keydown", markPendingUserFocus, true);
    document.addEventListener("focusin", onFocusIn, true);
  }
  if (typeof window !== "undefined") {
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("focus", onWindowFocus);
  }

  try {
    return await operation();
  } finally {
    if (typeof document !== "undefined") {
      document.removeEventListener("pointerdown", markPendingUserFocus, true);
      document.removeEventListener("keydown", markPendingUserFocus, true);
      document.removeEventListener("focusin", onFocusIn, true);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("focus", onWindowFocus);
    }

    const activeElement = getMeaningfulActiveElement();
    const activeFocusIsExpected =
      !activeElement || activeElement === previouslyFocused || activeElement === nativeFocusElement;
    if (
      operationId === latestOperationId &&
      !userFocusObserved &&
      wasDocumentFocused &&
      !windowBlurred &&
      isDocumentFocused() &&
      previouslyFocused?.isConnected &&
      activeFocusIsExpected &&
      activeElement !== previouslyFocused
    ) {
      try {
        previouslyFocused.focus({ preventScroll: true });
      } catch {
        // Focus restoration is best effort; never mask the automation result.
      }
    }
  }
}
