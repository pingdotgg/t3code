import type * as NodeEvents from "node:events";

type DialogCallback = (accepted: boolean, prompt: string) => void;
type DialogListener = (info: unknown, callback: DialogCallback) => void;
type DialogContents = Pick<NodeEvents.EventEmitter, "on" | "off" | "rawListeners"> & {
  readonly debugger: Pick<NodeEvents.EventEmitter, "on" | "off">;
};

// Electron 44 has no public dialog interception hook; its -run-dialog listener opens a
// native modal even when CDP handles the dialog. Preserve that listener for human input.
// https://github.com/electron/electron/blob/v44.10.1/lib/browser/api/web-contents.ts
export function interceptNativeDialogs(contents: DialogContents, agentOwnsPage: () => boolean) {
  const nativeListeners = contents.rawListeners("-run-dialog") as DialogListener[];
  const pending = new Set<DialogCallback>();
  let disposed = false;
  const cancel = () => {
    const callbacks = [...pending];
    pending.clear();
    for (const callback of callbacks) callback(false, "");
  };
  const run = (info: unknown, callback: DialogCallback) => {
    if (agentOwnsPage()) pending.add(callback);
    else
      for (const listener of nativeListeners) Reflect.apply(listener, contents, [info, callback]);
  };
  const closed = (_event: unknown, method: string) => {
    // CDP and Electron share Chromium's one-shot dialog result. CDP already settled it.
    if (method === "Page.javascriptDialogClosed") pending.clear();
  };
  const navigating = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !inPlace) cancel();
  };
  for (const listener of nativeListeners) contents.off("-run-dialog", listener);
  contents.on("-run-dialog", run);
  contents.on("-cancel-dialogs", cancel);
  contents.on("did-start-navigation", navigating);
  contents.on("destroyed", cancel);
  contents.debugger.on("message", closed);
  contents.debugger.on("detach", cancel);

  // beforeunload uses will-prevent-unload and resolves synchronously in Electron;
  // it has no deferred callback and does not pass through -run-dialog.
  return () => {
    if (disposed) return;
    disposed = true;
    contents.off("-run-dialog", run);
    for (const listener of nativeListeners) contents.on("-run-dialog", listener);
    contents.off("-cancel-dialogs", cancel);
    contents.off("did-start-navigation", navigating);
    contents.off("destroyed", cancel);
    contents.debugger.off("message", closed);
    contents.debugger.off("detach", cancel);
    cancel();
  };
}
