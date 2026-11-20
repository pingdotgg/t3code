import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";
import { PREVIEW_ERROR_CODE_MESSAGES } from "./previewConstants";

/** Components pass `useMessages()` so the message follows a language switch. */
export function describePreviewError(description: string, resolve: MessageResolver = m): string {
  const friendly = PREVIEW_ERROR_CODE_MESSAGES[description];
  if (friendly) return resolve(friendly);
  if (description.length > 0) return description;
  return resolve(msg("Network error"));
}
