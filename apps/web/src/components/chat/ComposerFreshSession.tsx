import { EraserIcon } from "lucide-react";

import { translateDynamic } from "../../i18nCore";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Shown while `/clear` is armed; dismissing it keeps the current conversation. */
export function freshSessionBannerItem(onUndo: () => void): ComposerBannerStackItem {
  return {
    id: "fresh-session",
    variant: "info",
    icon: <EraserIcon />,
    title: translateDynamic("composer:freshSession.title"),
    description: translateDynamic("composer:freshSession.description"),
    dismissLabel: translateDynamic("composer:freshSession.dismiss"),
    onDismiss: onUndo,
  };
}
