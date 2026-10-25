import * as Schema from "effect/Schema";

import { ChatAttachment } from "./chatAttachment.ts";
import {
  GuestMessageId,
  GuestShareId,
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

/**
 * A guest share lets one unauthenticated browser watch a thread over T3 Connect and propose
 * messages the owner must send or dismiss. The thread projection holds this public state; the
 * credentials are derived from the share id with a server key and never stored.
 */
export const GUEST_SHARE_TTL_MS = 24 * 60 * 60 * 1000;
export const GUEST_MESSAGE_MAX_LENGTH = 4_000;
export const GUEST_NAME_MAX_LENGTH = 40;
export const GUEST_PENDING_MESSAGE_LIMIT = 3;
/** Resolved messages kept so the guest can see what happened to what they sent. */
export const GUEST_RESOLVED_MESSAGE_LIMIT = 20;
/** Files a guest can attach to one message, and their total size. */
export const GUEST_MESSAGE_MAX_ATTACHMENTS = 4;
export const GUEST_MESSAGE_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Total size of the files in a share's waiting messages, so a guest cannot fill the disk. */
export const GUEST_PENDING_ATTACHMENT_BYTES_LIMIT = 20 * 1024 * 1024;

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
  /** The T3 Connect tunnel hostname the link points at. Guest routes require it to still serve. */
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

export const GuestShareCreateInput = Schema.Struct({ threadId: ThreadId });
export type GuestShareCreateInput = typeof GuestShareCreateInput.Type;

export const GuestShareCreateResult = Schema.Struct({
  url: TrimmedNonEmptyString,
  share: ThreadGuestShare,
});
export type GuestShareCreateResult = typeof GuestShareCreateResult.Type;

const GUEST_SHARE_CREATE_MESSAGES = {
  disabled: "Guest links are off. Turn them on in Settings > Beta.",
  connect_unavailable: "Guest links need a running T3 Connect tunnel.",
  thread_unavailable: "This thread cannot be shared.",
  read_failed: "Failed to read the shared thread.",
  changed: "The guest link changed while it was being created.",
} as const;

export class GuestShareCreateError extends Schema.TaggedError<GuestShareCreateError>()(
  "GuestShareCreateError",
  {
    reason: Schema.Literals([
      "disabled",
      "connect_unavailable",
      "thread_unavailable",
      "read_failed",
      "changed",
    ]),
  },
) {
  override get message(): string {
    return GUEST_SHARE_CREATE_MESSAGES[this.reason];
  }
}

// The name lands in the agent's attribution line, so it must stay one plain line, and the owner
// reads it, so direction overrides cannot make it look like another name.
const NAME_BREAKING_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

export const GuestRedeemRequest = Schema.Struct({
  credential: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString.check(
    Schema.isMaxLength(GUEST_NAME_MAX_LENGTH),
    Schema.makeFilter((name) => !NAME_BREAKING_CHARACTER.test(name), {
      description: "a single line of text",
    }),
  ),
});
export type GuestRedeemRequest = typeof GuestRedeemRequest.Type;

/**
 * The fields of a guest message. The page posts them as multipart form data, with each file as a
 * `file` part; text can be empty when files are attached.
 */
export const GuestSubmitRequest = Schema.Struct({
  /** The share the page shows, so a message from a page for a replaced link is refused instead
      of reaching the new one. */
  shareId: GuestShareId,
  text: TrimmedString.check(Schema.isMaxLength(GUEST_MESSAGE_MAX_LENGTH)),
});
export type GuestSubmitRequest = typeof GuestSubmitRequest.Type;

export const GUEST_ROUTE_PREFIX = "/api/guest";
/** The guest page and guest routes name the share they mean with this query parameter. */
export const GUEST_SHARE_PARAM = "share";

/**
 * One session cookie per share, so a guest keeps every link they joined on a host, and a page
 * for one share never acts with another share's session.
 */
export const guestSessionCookieName = (shareId: string) => `t3_guest_${shareId}`;
/** Serves one HTML render in the shared thread: `?share=<share id>&item=<turn item id>`. */
export const GUEST_RENDER_ROUTE = `${GUEST_ROUTE_PREFIX}/render`;
/** One item of the shared thread, as an expanded row loads it: `?share=<share id>&item=<id>`. */
export const GUEST_ITEM_ROUTE = `${GUEST_ROUTE_PREFIX}/item`;
/** Server-sent output frames of one command in the shared thread: `?share=<share id>&item=<id>`. */
export const GUEST_COMMAND_OUTPUT_ROUTE = `${GUEST_ROUTE_PREFIX}/command-output`;
/**
 * A file in the shared thread or a guest's waiting message: `?share=<share id>&id=<attachment id>`.
 * Images load inline; other files download.
 */
export const GUEST_ATTACHMENT_ROUTE = `${GUEST_ROUTE_PREFIX}/attachment`;
