import { CornerDownLeftIcon } from "lucide-react";

import { isMacPlatform } from "~/lib/utils";
import { Kbd } from "./ui/kbd";

/**
 * The key hint at the end of a dialog's submit button: Enter, or ⌘ Enter (Ctrl Enter off macOS)
 * for dialogs that submit with the modifier. The dialog must handle the key it shows.
 */
export function SubmitKbd({ mod = false }: { mod?: boolean }) {
  return (
    <Kbd aria-hidden>
      {mod ? (isMacPlatform(navigator.platform) ? "⌘" : "Ctrl") : null}
      <CornerDownLeftIcon />
    </Kbd>
  );
}
