// A document's CSP cannot stop frame navigation; Electron vetoes isolated-subtree navigation unless the main frame starts it.
// Allow about:srcdoc mounting; wrapper CSP blocks data: navigation and ping liveness detects about:blank.

export interface NavigationFrame {
  readonly url: string;
  readonly origin: string;
  readonly frameToken: string;
  readonly name: string;
  readonly parent: NavigationFrame | null;
}

const isViewDocument = (frame: NavigationFrame) =>
  frame.name === "t3-plugin-view" && frame.url === "about:srcdoc" && frame.origin === "null";

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
