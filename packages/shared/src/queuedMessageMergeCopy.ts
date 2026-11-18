import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { QueuedMessageMergeBlockedKind } from "./queuedMessageMerge.ts";

const BLOCKED_REASON_COPY: Readonly<Record<QueuedMessageMergeBlockedKind, string>> = {
  tooFew: msg("Queue two or more messages to send them as one."),
  loading: msg("Some queued messages are still loading."),
  guest: msg("A guest's message can't be combined with others."),
  automated: msg("Messages from agents and automations are sent on their own."),
  command: msg("Commands are sent on their own."),
  freshContext: msg("A message that starts a fresh session is sent on its own."),
  continuation: msg("Plan and continuation messages are sent on their own."),
  modelMismatch: msg("Queued messages use different models."),
  sharedAttachment: msg("Queued messages share an attachment."),
  tooManyAttachments: msg("You can attach up to {max} files per message.", {
    max: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  }),
  imagesTooLarge: msg(
    "Images can total up to {max} MiB per message. Use smaller images or send fewer at once.",
    { max: PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES / (1024 * 1024) },
  ),
  conflictingContext: msg("Queued messages have conflicting context."),
  tooMuchContext: msg("Queued messages carry too much context to send as one."),
  tooLong: msg("Queued messages are too long to send as one."),
};

export function queuedMessageMergeBlockedReason(
  kind: QueuedMessageMergeBlockedKind,
  resolve: MFunctionType = mFallback,
): string {
  return resolve(BLOCKED_REASON_COPY[kind]);
}
