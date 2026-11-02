import type { KeyboardEvent } from "react";

import { isMacPlatform } from "~/lib/utils";
import { SubmitKbd } from "./SubmitKbd";

/** The mod+Enter key cap a dialog's primary button carries. */
export function DialogSubmitKbd() {
  return <SubmitKbd mod />;
}

/** True for mod+Enter, the shortcut that runs a dialog's primary action from any field. */
export function isDialogSubmitShortcut(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing) {
    return false;
  }
  return isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
}
