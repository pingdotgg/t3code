import * as Schema from "effect/Schema";

import { ChatAttachment } from "./chatAttachment.ts";
import { GuestMessageId, GuestShareId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Guest links were removed with T3 Connect. Stored thread events and projections still carry
 * this state, so it stays decodable and the owner can still send, dismiss, or close it.
 */
export const GUEST_MESSAGE_MAX_LENGTH = 4_000;
export const GUEST_NAME_MAX_LENGTH = 40;
export const GUEST_RESOLVED_MESSAGE_LIMIT = 20;

export const ThreadGuestMessageStatus = Schema.Literals(["pending", "sent", "dismissed"]);
export type ThreadGuestMessageStatus = typeof ThreadGuestMessageStatus.Type;

export const ThreadGuestMessage = Schema.Struct({
  id: GuestMessageId,
  text: Schema.String,
  status: ThreadGuestMessageStatus,
  submittedAt: IsoDateTime,
  /** The thread's attachments, deleted if the message is dismissed. Absent on older messages. */
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
});
export type ThreadGuestMessage = typeof ThreadGuestMessage.Type;

export const ThreadGuestShare = Schema.Struct({
  id: GuestShareId,
  host: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  /** Set once, when the guest redeems the link. */
  guestName: Schema.NullOr(TrimmedNonEmptyString),
  messages: Schema.Array(ThreadGuestMessage),
});
export type ThreadGuestShare = typeof ThreadGuestShare.Type;

export const pendingGuestMessageCount = (share: ThreadGuestShare | null | undefined): number =>
  share?.messages.filter((message) => message.status === "pending").length ?? 0;
