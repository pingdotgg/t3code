import { webFrameMain, type WebContents, type WebFrameMain } from "electron";

import {
  FRAME_PICK_COMMAND_CHANNEL,
  FRAME_PICK_ESCAPE_CHANNEL,
  FRAME_PICK_MESSAGE_KEY,
  installFramePickAgent,
  type FramePickCommand,
} from "./FramePickAgent.ts";

const agentSourceFor = (documentToken: string): string =>
  `(${installFramePickAgent.toString()})(${JSON.stringify(FRAME_PICK_MESSAGE_KEY)}, undefined, ${JSON.stringify(documentToken)});`;

const commandSourceFor = (documentToken: string, command: FramePickCommand): string =>
  `(() => { const agent = window[${JSON.stringify(FRAME_PICK_MESSAGE_KEY)}]; return agent && typeof agent.runCommandForDocument === "function" ? agent.runCommandForDocument(${JSON.stringify(documentToken)}, ${JSON.stringify(command)}) ?? null : null; })()`;

const CSS_PROPERTY = /^-?[a-z][a-z-]*$/;
const MAX_STYLE_VALUE_CHARS = 1_000;

function parseFramePickCommand(value: unknown): FramePickCommand | null {
  if (typeof value !== "object" || value === null) return null;
  const { kind, id, property, value: styleValue } = value as Record<string, unknown>;
  if (typeof id !== "string" || id.length > 32) return null;
  if (kind === "capture" || kind === "describe" || kind === "restore") return { kind, id };
  if (
    kind === "style" &&
    typeof property === "string" &&
    CSS_PROPERTY.test(property) &&
    typeof styleValue === "string" &&
    styleValue.length <= MAX_STYLE_VALUE_CHARS
  ) {
    return { kind, id, property, value: styleValue };
  }
  return null;
}

const commandOwnerByWebContents = new WeakMap<WebContents, symbol>();
let injectedDocuments = 0;

export function watchFramesForPick(wc: WebContents): () => void {
  const owner = Symbol("frame-pick-session");
  const framesByDocumentToken = new Map<string, WebFrameMain>();

  const injectAgent = (frame: WebFrameMain | null | undefined): void => {
    if (!frame || frame.detached) return;
    injectedDocuments += 1;
    const documentToken = `${frame.processId}.${frame.routingId}.${injectedDocuments}`;
    framesByDocumentToken.set(documentToken, frame);
    frame.executeJavaScript(agentSourceFor(documentToken)).catch(() => undefined);
  };

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

  const runCommand = async (
    _event: Electron.IpcMainInvokeEvent,
    documentToken: unknown,
    rawCommand: unknown,
  ): Promise<unknown> => {
    const command = parseFramePickCommand(rawCommand);
    if (typeof documentToken !== "string" || !command) return null;
    const frame = framesByDocumentToken.get(documentToken);
    if (!frame || frame.detached) return null;
    return frame.executeJavaScript(commandSourceFor(documentToken, command)).catch(() => null);
  };

  const onInput = (_event: Electron.Event, input: Electron.Input): void => {
    if (input.type !== "keyDown" || input.key !== "Escape" || input.isAutoRepeat) return;
    wc.send(FRAME_PICK_ESCAPE_CHANNEL);
  };

  wc.on("did-frame-finish-load", onFrameLoaded);
  wc.on("before-input-event", onInput);
  wc.ipc.removeHandler(FRAME_PICK_COMMAND_CHANNEL);
  wc.ipc.handle(FRAME_PICK_COMMAND_CHANNEL, runCommand);
  commandOwnerByWebContents.set(wc, owner);
  return () => {
    wc.off("did-frame-finish-load", onFrameLoaded);
    wc.off("before-input-event", onInput);
    if (commandOwnerByWebContents.get(wc) === owner) {
      wc.ipc.removeHandler(FRAME_PICK_COMMAND_CHANNEL);
      commandOwnerByWebContents.delete(wc);
    }
    framesByDocumentToken.clear();
  };
}
