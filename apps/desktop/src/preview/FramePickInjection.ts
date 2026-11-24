import { webFrameMain, type WebContents, type WebFrameMain } from "electron";

import { FRAME_PICK_MESSAGE_KEY, installFramePickAgent } from "./FramePickAgent.ts";

const agentSource = `(${installFramePickAgent.toString()})(${JSON.stringify(FRAME_PICK_MESSAGE_KEY)});`;

const injectAgent = (frame: WebFrameMain | null | undefined): void => {
  if (!frame || frame.detached) return;
  frame.executeJavaScript(agentSource).catch(() => undefined);
};

export function watchFramesForPick(wc: WebContents): () => void {
  const mainFrame = wc.mainFrame;
  for (const frame of mainFrame?.framesInSubtree ?? []) {
    if (frame !== mainFrame) injectAgent(frame);
  }
  const onFrameLoaded = (
    _event: Electron.Event,
    isMainFrame: boolean,
    processId: number,
    routingId: number,
  ): void => {
    if (!isMainFrame) injectAgent(webFrameMain.fromId(processId, routingId));
  };
  wc.on("did-frame-finish-load", onFrameLoaded);
  return () => {
    wc.off("did-frame-finish-load", onFrameLoaded);
  };
}
