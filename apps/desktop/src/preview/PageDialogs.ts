import type { DesktopPreviewDialog } from "@t3tools/contracts";

type DialogCallback = (accept: boolean, userInput: string) => void;

interface RunDialogInfo {
  readonly dialogType: string;
  readonly messageText: string;
  readonly defaultPromptText: string;
}

export interface PageDialogHold {
  /** Answers the pending dialog; false when none is pending. */
  readonly answer: (accept: boolean, promptText?: string) => boolean;
  /** Forgets the pending dialog after something else, such as CDP, closed it. */
  readonly closed: () => void;
  readonly release: () => void;
}

// Electron shows page dialogs as a native app-modal box from the `-run-dialog` event and never
// closes it when CDP answers. Replacing that listener keeps the dialog pending for the tab's UI.
export function holdPageDialogs(
  contents: NodeJS.EventEmitter,
  changed: (dialog: DesktopPreviewDialog | null) => void,
): PageDialogHold {
  const native = contents.listeners("-run-dialog") as Array<(...args: unknown[]) => void>;
  let pending: DialogCallback | null = null;
  const clear = () => {
    if (pending === null) return;
    pending = null;
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
    const previous = pending;
    if (previous !== null) deliver(previous, false, "");
    pending = callback;
    changed({
      type: info.dialogType,
      message: info.messageText,
      defaultValue: info.defaultPromptText,
    });
  };
  for (const listener of native) contents.off("-run-dialog", listener);
  contents.on("-run-dialog", run);
  contents.on("-cancel-dialogs", clear);
  return {
    answer: (accept, promptText) => {
      const callback = pending;
      if (callback === null) return false;
      clear();
      return deliver(callback, accept, promptText ?? "");
    },
    closed: clear,
    release: () => {
      const callback = pending;
      clear();
      if (callback !== null) deliver(callback, false, "");
      contents.off("-run-dialog", run);
      contents.off("-cancel-dialogs", clear);
      for (const listener of native) contents.on("-run-dialog", listener);
    },
  };
}
