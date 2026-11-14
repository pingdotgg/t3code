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
  readonly current: () => DesktopPreviewDialog | null;
}

// Electron shows page dialogs as a native app-modal box from the `-run-dialog` event and never
// closes it when CDP answers. Replacing that listener keeps the dialog pending for the tab's UI.
export function holdPageDialogs(
  contents: NodeJS.EventEmitter,
  changed: (dialog: DesktopPreviewDialog | null) => void,
): PageDialogHold {
  let pending: DialogCallback | null = null;
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
    const previous = pending;
    if (previous !== null) deliver(previous, false, "");
    pending = callback;
    shown = {
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
  contents.on("-cancel-dialogs", clear);
  return {
    answer: (accept, promptText) => {
      const callback = pending;
      if (callback === null) return false;
      clear();
      return deliver(callback, accept, promptText ?? "");
    },
    closed: clear,
    current: () => shown,
  };
}
