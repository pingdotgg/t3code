import { EraserIcon, NotebookPenIcon } from "lucide-react";

import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Shown while `/clear` or `/recap` is armed; dismissing it keeps the current conversation. */
export function freshSessionBannerItem(
  onUndo: () => void,
  options?: { readonly withRecap?: boolean },
): ComposerBannerStackItem {
  if (options?.withRecap === true) {
    return {
      id: "fresh-session-recap",
      variant: "info",
      icon: <NotebookPenIcon />,
      title: "Your next message starts a fresh session with a recap",
      description:
        "Earlier messages stay visible. The new session gets a written handoff, not Compact (same session) or Clear (no history).",
      dismissLabel: "Keep the current session",
      onDismiss: onUndo,
    };
  }
  return {
    id: "fresh-session",
    variant: "info",
    icon: <EraserIcon />,
    title: "Your next message starts a fresh session",
    description: "The agent won't see earlier messages in this thread.",
    dismissLabel: "Keep the current session",
    onDismiss: onUndo,
  };
}
