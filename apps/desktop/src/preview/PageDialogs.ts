import type { DesktopPreviewDialog } from "@t3tools/contracts";

type DialogCallback = (accept: boolean, userInput: string) => void;

interface RunDialogInfo {
  readonly dialogType: string;
  readonly messageText: string;
  readonly defaultPromptText: string;
}

export interface PageDialogHold {
  /** Answers the pending dialog; with `id`, only when it is still that dialog. */
  readonly answer: (accept: boolean, id?: number) => boolean;
  readonly closed: () => void;
  readonly current: () => DesktopPreviewDialog | null;
}

// Electron shows page dialogs as a native app-modal box from the `-run-dialog` event and never
// closes it when CDP answers. Replacing that listener keeps the dialog pending for the tab's UI.
// Electron does not support `prompt()` and rejects it at once; we keep that.
export function holdPageDialogs(
  contents: NodeJS.EventEmitter,
  changed: (dialog: DesktopPreviewDialog | null) => void,
): PageDialogHold {
  let pending: DialogCallback | null = null;
  let nextId = 0;
  let shown: DesktopPreviewDialog | null = null;
  const clear = () => {
    if (pending === null) return;
    pending = null;
    shown = null;
    changed(null);
  };
  const deliver = (callback: DialogCallback, accept: boolean, userInput: string) => {
    try {
      callback(accept, userInput);
      return true;
    } catch {
      return false;
    }
  };
  const run = (info: RunDialogInfo, callback: DialogCallback) => {
    if (info.dialogType === "prompt") {
      deliver(callback, false, "");
      return;
    }
    const previous = pending;
    if (previous !== null) deliver(previous, false, "");
    pending = callback;
    nextId += 1;
    shown = {
      id: nextId,
      type: info.dialogType,
      message: info.messageText,
      defaultValue: info.defaultPromptText,
    };
    changed(shown);
  };
  for (const listener of contents.listeners("-run-dialog")) {
    contents.off("-run-dialog", listener as (...args: unknown[]) => void);
  }
  contents.on("-run-dialog", run);
  const answer = (accept: boolean, id?: number) => {
    const callback = pending;
    if (callback === null || (id !== undefined && shown?.id !== id)) return false;
    clear();
    return deliver(callback, accept, "");
  };
  contents.on("-cancel-dialogs", clear);
  // Chrome dismisses page dialogs when a navigation starts; a held one would block the commit.
  contents.on(
    "did-start-navigation",
    (event: { readonly isMainFrame: boolean; readonly isSameDocument: boolean }) => {
      if (event.isMainFrame && !event.isSameDocument) answer(false);
    },
  );
  return { answer, closed: clear, current: () => shown };
}
