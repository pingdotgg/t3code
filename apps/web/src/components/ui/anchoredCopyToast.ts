import type { RefObject } from "react";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import { anchoredToastManager } from "./toast";

export const ANCHORED_COPY_TOAST_TIMEOUT_MS = 1000;

export function showAnchoredCopyErrorToast(ref: RefObject<HTMLButtonElement | null>, error: Error) {
  if (!ref.current) return;
  anchoredToastManager.add({
    type: "error",
    positionerProps: {
      anchor: ref.current,
    },
    title: m(msg("Failed to copy")),
    description: error.message,
  });
}
