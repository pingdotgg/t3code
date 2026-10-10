/**
 * Main-process navigation veto for isolated plugin view frames.
 *
 * A plugin view runs in an opaque-origin `about:srcdoc` frame inside a
 * policy wrapper frame of the same kind. A document's own CSP cannot stop its
 * frame navigating, so the main process refuses any navigation of a frame in
 * such a subtree unless the app's main frame started it. Loading
 * `about:srcdoc` stays allowed so the wrapper can mount its view. Electron
 * does not report `about:blank` or `data:` here: the wrapper's CSP refuses
 * `data:`, and the host's ping liveness check ends a view that blanked itself.
 */

export interface NavigationFrame {
  readonly url: string;
  readonly origin: string;
  readonly frameToken: string;
  readonly parent: NavigationFrame | null;
}

const isViewDocument = (frame: NavigationFrame) =>
  frame.url === "about:srcdoc" && frame.origin === "null";

export function shouldVetoViewFrameNavigation(input: {
  readonly url: string;
  readonly frame: NavigationFrame | null;
  readonly initiator: NavigationFrame | null | undefined;
  readonly mainFrame: NavigationFrame;
}): boolean {
  let insideView = false;
  for (let frame = input.frame; frame !== null; frame = frame.parent) {
    if (isViewDocument(frame)) insideView = true;
  }
  if (!insideView || input.url === "about:srcdoc") return false;
  return input.initiator?.frameToken !== input.mainFrame.frameToken;
}
