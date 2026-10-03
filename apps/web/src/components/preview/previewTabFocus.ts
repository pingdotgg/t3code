type HumanInputSubscription = (takeOver: (runtimeTabId: string) => void) => () => void;

// A traversal can outlive its key receipt. Subsequent Tab presses share that
// pending transition rather than accumulating guards or dropping late focus.
let currentGuard: ReturnType<typeof createGuard> | undefined;

function createGuard(previous: HTMLElement, onHumanInput: HumanInputSubscription) {
  let released = false;
  let presses = 0;
  let pendingTraversal = false;
  let restoredGuest: HTMLElement | null = null;
  let unsubscribe = () => {};
  const stopKeepingFocus = () => {
    document.removeEventListener("focusout", keepHostFocus, true);
    document.removeEventListener("focus", keepHostFocus, true);
  };
  const release = () => {
    if (released) return;
    released = true;
    stopKeepingFocus();
    document.removeEventListener("pointerdown", relinquish, true);
    document.removeEventListener("keydown", relinquish, true);
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.removeEventListener("pagehide", release);
    removed.disconnect();
    unsubscribe();
    if (currentGuard?.release === release) currentGuard = undefined;
  };
  const relinquish = (event: Event) => {
    if (
      event.target instanceof Node &&
      previous.contains(event.target) &&
      (previous.isContentEditable ||
        previous instanceof HTMLTextAreaElement ||
        (previous instanceof HTMLInputElement &&
          ["text", "search", "email", "tel", "url", "password", "number"].includes(
            previous.type,
          ))) &&
      (event.type === "pointerdown" ||
        (event instanceof KeyboardEvent &&
          (event.isComposing ||
            ["Shift", "Control", "Alt", "Meta", "AltGraph", "Dead", "Process"].includes(
              event.key,
            ) ||
            (!["Tab", "Escape"].includes(event.key) &&
              (event.key !== "Enter" || event.shiftKey) &&
              (!(event.metaKey || event.ctrlKey) ||
                [
                  "a",
                  "c",
                  "x",
                  "v",
                  "z",
                  "y",
                  "Backspace",
                  "Delete",
                  "ArrowLeft",
                  "ArrowRight",
                  "ArrowUp",
                  "ArrowDown",
                  "Home",
                  "End",
                ].includes(event.key.length === 1 ? event.key.toLowerCase() : event.key))))))
    ) {
      // Typing and caret editing leave focus here. Keep protecting the user's next
      // characters from a delayed agent traversal; navigation still yields.
      return;
    }
    // HostedBrowserWebview replays guest focus to dismiss popups. The real
    // guest pointer signal follows through IPC, so this is not human input.
    if (
      !event.isTrusted &&
      event.target instanceof HTMLElement &&
      event.target.localName === "webview"
    )
      return;
    release();
  };
  const takeOver = (runtimeTabId: string) => {
    if (released) return;
    const guest = restoredGuest;
    const restoreHumanFocus =
      guest?.isConnected &&
      guest.getAttribute("data-preview-tab") === runtimeTabId &&
      document.activeElement === previous;
    release();
    // Guest focus can precede the trusted pointer IPC. If we corrected that
    // focus, return it to this guest only when its human signal confirms intent.
    if (restoreHumanFocus) guest.focus({ preventScroll: true });
  };
  const settle = () => {
    if (released || presses > 0) return;
    if (!previous.isConnected) release();
    else if (!pendingTraversal) release();
  };
  const keepHostFocus = (event: Event) => {
    if (released) return;
    if (!previous.isConnected) {
      release();
      return;
    }
    const target = event.target;
    if (event.type === "focusout") {
      if (target !== previous || document.activeElement !== document.body) return;
      pendingTraversal = true;
      previous.focus({ preventScroll: true });
      return;
    }
    if (target instanceof HTMLElement && target === document.activeElement && target !== previous) {
      restoredGuest = target.localName === "webview" ? target : null;
      previous.focus({ preventScroll: true });
      // Destination events cannot be paired with key receipts. Several queued
      // traversals can arrive separately, so retain this one guard until human
      // navigation or lifecycle cleanup, rather than ending it at the first.
      pendingTraversal = true;
      settle();
    }
  };
  const visibilityChanged = () => {
    if (document.visibilityState === "hidden") release();
  };
  const removed = new MutationObserver(() => {
    if (!previous.isConnected) release();
  });
  removed.observe(document, { childList: true, subtree: true });
  document.addEventListener("pointerdown", relinquish, true);
  document.addEventListener("keydown", relinquish, true);
  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("pagehide", release);
  unsubscribe = onHumanInput(takeOver);
  if (released) unsubscribe();

  const run = async <A>(press: () => Promise<A>) => {
    if (released) return await press();
    presses++;
    document.addEventListener("focusout", keepHostFocus, true);
    document.addEventListener("focus", keepHostFocus, true);
    let completed = false;
    try {
      const result = await press();
      completed = true;
      return result;
    } finally {
      presses--;
      if (!completed && presses === 0) release();
      else settle();
    }
  };
  return {
    previous,
    run,
    release,
    get released() {
      return released;
    },
  };
}

/** Preserve host focus across native Tab traversal without a focus timer. */
export async function runPreviewTabKeepingHostFocus<A>(
  press: () => Promise<A>,
  onHumanInput: HumanInputSubscription,
): Promise<A> {
  const previous = document.activeElement;
  if (currentGuard?.previous !== previous) currentGuard?.release();
  if (
    !(previous instanceof HTMLElement) ||
    previous === document.body ||
    previous.localName === "webview"
  )
    return await press();

  const guard = currentGuard ?? createGuard(previous, onHumanInput);
  if (!guard.released) currentGuard = guard;
  return await guard.run(press);
}
