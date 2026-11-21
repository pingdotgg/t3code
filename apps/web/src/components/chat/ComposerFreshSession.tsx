import { msg } from "gt-react";
import { EraserIcon } from "lucide-react";

import { m, type MessageResolver } from "../../i18n/messages";

import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Shown while `/clear` is armed; dismissing it keeps the current conversation. */
export function freshSessionBannerItem(
  onUndo: () => void,
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  return {
    id: "fresh-session",
    variant: "info",
    icon: <EraserIcon />,
    title: resolve(msg("Your next message starts a fresh session")),
    description: resolve(msg("The agent won't see earlier messages in this thread.")),
    dismissLabel: resolve(msg("Keep the current session")),
    onDismiss: onUndo,
  };
}
