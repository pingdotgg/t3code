import * as Schema from "effect/Schema";

import { GuestShareId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadGuestMessage } from "./guestShare.ts";
import { OrchestrationV2ThreadStreamItem } from "./orchestrationV2.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

// This lives apart from guestShare.ts because orchestrationV2.ts imports that file.

/**
 * What the composer's model label shows; nothing else from the owner's provider settings. The
 * driver is null when the thread's provider is no longer configured.
 */
export const GuestThreadModel = Schema.Struct({
  driver: Schema.NullOr(ProviderDriverKind),
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
});
export type GuestThreadModel = typeof GuestThreadModel.Type;

export const GuestShareView = Schema.Struct({
  shareId: GuestShareId,
  title: Schema.String,
  guestName: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  messages: Schema.Array(ThreadGuestMessage),
  model: GuestThreadModel,
});
export type GuestShareView = typeof GuestShareView.Type;

/**
 * The shared thread as the owner's client gets it: `thread` carries the same stream items the
 * owner's thread subscription sends, starting with a snapshot on every (re)connect. `view` is the
 * share itself, sent first and again when it changes.
 */
export const GuestStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("view"), view: GuestShareView }),
  Schema.Struct({ type: Schema.Literal("thread"), item: OrchestrationV2ThreadStreamItem }),
  Schema.Struct({ type: Schema.Literal("ended") }),
]);
export type GuestStreamEvent = typeof GuestStreamEvent.Type;
