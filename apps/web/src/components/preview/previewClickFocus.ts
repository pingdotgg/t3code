interface PreviewClick {
  readonly runtimeTabId: string;
  readonly order: number;
  previous: Element | null;
}

// Agent clicks can overlap across tabs and threads.
const inFlightClicks = new Set<PreviewClick>();
let nextClickOrder = 0;

const focusedPreviewTab = (element: Element | null): string | null =>
  element?.localName === "webview" ? element.getAttribute("data-preview-tab") : null;

const restoreHostFocus = ({ runtimeTabId, previous }: PreviewClick): void => {
  const current = document.activeElement;
  if (
    !(current instanceof HTMLElement) ||
    current === previous ||
    focusedPreviewTab(current) !== runtimeTabId
  ) {
    return;
  }
  if (previous instanceof HTMLElement && previous.isConnected && previous !== document.body) {
    previous.focus({ preventScroll: true });
  }
  // The previous element may no longer take focus, like a composer that was
  // disabled during the click. Never leave focus in the page.
  if (document.activeElement === current) current.blur();
};

/**
 * Runs an agent click in a preview tab and hands keyboard focus back to the
 * host page afterwards.
 *
 * The desktop dispatches the click as a CDP mouse press, which focuses the
 * guest page, and nothing gives that focus back. The user's next keystrokes
 * then go into the page, even when its tab is hidden or belongs to another
 * thread. Only the host document knows what had focus before the click, so
 * the restore happens here and not in the desktop main process.
 */
export async function runPreviewClickKeepingHostFocus<A>(
  runtimeTabId: string,
  click: () => Promise<A>,
): Promise<A> {
  const entry: PreviewClick = {
    runtimeTabId,
    order: nextClickOrder++,
    previous: document.activeElement,
  };
  inFlightClicks.add(entry);
  try {
    return await click();
  } finally {
    // Also runs when the click fails: a keystroke that reaches the page after
    // the press counts as human input and fails the click as interrupted.
    inFlightClicks.delete(entry);
    // A click that started while this one held focus in its page saw that page
    // as what had focus. Hand it this click's target instead. A click that never
    // finishes never gets here, so it cannot override where the user goes later.
    for (const other of inFlightClicks) {
      if (other.order > entry.order && focusedPreviewTab(other.previous) === runtimeTabId) {
        other.previous = entry.previous;
      }
    }
    restoreHostFocus(entry);
  }
}
