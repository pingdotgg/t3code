import { useState } from "react";

/** Keeps source mode and dismissed line reveals local to the current document. */
export function useFilePreviewRenderState(
  path: string | null,
  revealLine: number | null,
  revealRequestId: number,
) {
  const [state, setState] = useState<{
    path: string | null;
    htmlRendered: boolean;
    handledRevealRequestId: number | null;
  }>({ path, htmlRendered: true, handledRevealRequestId: null });
  if (state.path !== path) {
    setState({ path, htmlRendered: true, handledRevealRequestId: null });
  }
  return {
    htmlRendered: state.path === path ? state.htmlRendered : true,
    revealHandled:
      revealLine === null ||
      (state.path === path && state.handledRevealRequestId === revealRequestId),
    setRendered(rendered: boolean) {
      setState({
        path,
        htmlRendered: rendered,
        handledRevealRequestId: rendered && path !== null ? revealRequestId : null,
      });
    },
  };
}
